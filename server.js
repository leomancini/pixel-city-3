import "dotenv/config";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";


const PORT = process.env.PORT || 3000;
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1";

if (!process.env.GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const STORY_SYSTEM = `You are the narrator of Pixel City 3.0, an endless choose-your-own-adventure game set in a sprawling, strange, lively pixel-art city.
Given the story so far and the player's latest choice, write what happens next and offer three ways to continue.
The text is shown in a small retro dialogue box, in large type, so keep it very short.
- "scene": at most 12 words, in second person, present tense, describing a single place or moment that would make a good picture, ending with a short question about what to do.
- "options": exactly three distinct actions the player could take next, each 2 or 3 short words, starting with a verb, no trailing punctuation. Make them lead in genuinely different directions.
- "picture": 30 to 45 words for the illustrator, never shown to the player, describing exactly what is visible in the scene at the moment the question is asked. The picture and the options must agree: everything an option refers to is visible in the picture, in the state it is in BEFORE that option is taken. If an option is "Open garage door", the picture says the garage door is shut; if an option is "Board the tram", the tram is waiting with the player still on the platform. Never offer an option the picture shows as already done or impossible.
Keep the tone playful and curious, keep it suitable for all ages, and never end the story.`;

const STORY_FORMAT = {
  type: "text",
  mime_type: "application/json",
  schema: {
    type: "object",
    properties: {
      scene: { type: "string" },
      picture: { type: "string" },
      options: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
    },
    required: ["scene", "picture", "options"],
  },
};

// The page sends each past step as "Player chose: <option> Then: <scene>".
// The last one is the scene the player was just looking at.
function previousScene(history) {
  const last = history[history.length - 1];
  if (!last) return "";
  const at = last.indexOf(" Then: ");
  return at === -1 ? last : last.slice(at + " Then: ".length);
}

async function generateStory(prompt, history) {
  const past = history.length
    ? `Story so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n\n`
    : "";
  const interaction = await ai.interactions.create({
    model: TEXT_MODEL,
    system_instruction: STORY_SYSTEM,
    // Spell out the question just asked and the answer given, so the next
    // scene follows directly from that exchange.
    input: history.length
      ? `${past}The player was just shown: "${previousScene(history)}"\nThe player answered: "${prompt}"\nContinue directly from that answer.`
      : `${past}The player chooses: ${prompt}`,
    response_format: STORY_FORMAT,
    store: false,
  });
  const story = JSON.parse(interaction.output_text);
  if (typeof story.scene !== "string" || !Array.isArray(story.options) || story.options.length < 3) {
    throw new Error("Story model returned an unexpected shape");
  }
  return {
    scene: story.scene,
    picture: typeof story.picture === "string" ? story.picture : "",
    options: story.options.slice(0, 3).map(String),
  };
}

// One fixed art direction for every level, so the game reads as a single
// world. Words alone drift (camera angle, pixel size, how big the people are),
// so every picture is also generated against the same reference image.
const ART_STYLE = `Draw a new scene for a pixel art video game, in exactly the art style of the attached reference image. The reference shows the style only: match its pixel size, outline weight, shading, colour palette, lighting, level of detail, camera and the scale of its people, but draw the new scene described below from scratch. Do not copy any of the reference's content: not its buildings, shopfronts, tram, tram stop, people or layout.
Camera: always a flat, straight-on side view, like a side-scrolling game background. Orthographic front elevation: the ground or floor is a level horizontal band along the bottom, buildings and objects face the viewer squarely, all horizontal lines are perfectly horizontal and all vertical lines perfectly vertical. No perspective, no vanishing point, no isometric or three-quarter angle, no aerial or tilted view.
Scale: a wide shot, never a close-up. People are small, each about one tenth of the image height, exactly as in the reference, and the place around them fills the picture. The player is one of these small figures, never a large foreground character.
Style: highly detailed 16-bit pixel art with the reference's fine, uniform pixel size, clean dark outlines, flat shading with a little dithering, and its dusk palette of deep purples and blues with warm window and neon accents, indoors as well as outdoors. Many small characters and props. No text, no letters, no UI.
Framing: a square, full-bleed image. The scene fills the whole canvas edge to edge on all four sides, with detailed artwork right up to every edge. No border, frame, vignette, letterbox bars, or empty black or blank bands at the top, bottom or sides; the ground or street continues, fully drawn, to the bottom edge.`;

const STYLE_REFERENCE = (await readFile(new URL("./art/style-reference.jpg", import.meta.url))).toString("base64");

async function generateImage({ scene, picture, options }, prompt, history) {
  // Tell the picture where the player has just come from and what they chose,
  // so it shows the outcome of that choice rather than an unrelated place.
  const context = history.length
    ? `\nStory context, for continuity only: the previous picture showed "${previousScene(history)}" and the player then chose "${prompt}". The new picture shows what that choice led to. Keep whatever carries over (the same character, companions, objects, weather and time of day), but draw only the new scene.`
    : "";
  // The picture has to agree with the choices offered under it: a door the
  // player can "open" must be drawn shut.
  const choices = `\nThe player will next choose one of: ${options.join("; ")}. None of these has happened yet. Show the moment before: everything they refer to is visible and still in its untouched state.`;
  const interaction = await ai.interactions.create({
    model: IMAGE_MODEL,
    input: [
      { type: "image", mime_type: "image/jpeg", data: STYLE_REFERENCE },
      { type: "text", text: `${ART_STYLE}${context}\nScene: ${scene}${picture ? `\nWhat is visible: ${picture}` : ""}${choices}` },
    ],
    // The page shows the picture small, so the smallest size is plenty, and
    // minimal thinking halves the wait and drops the thinking-token cost.
    response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: "1:1", image_size: "512" },
    generation_config: { thinking_level: "minimal" },
    store: false,
  });
  const image = interaction.output_image;
  if (!image?.data) throw new Error("Image model returned no image");
  return `data:${image.mime_type || "image/jpeg"};base64,${image.data}`;
}

// Diagnostics mode (DIAGNOSTICS=1 in .env, meant for local development):
// accepts the page's layout reports, and keeps the first three levels of the
// story on disk so reloading the page does not regenerate (and pay for) them.
const DIAGNOSTICS = process.env.DIAGNOSTICS === "1";
const CACHE_DIR = new URL("./.cache/levels/", import.meta.url);
const CACHED_DEPTH = 3;

function cacheFile(prompt, history) {
  const key = createHash("sha256").update(JSON.stringify([prompt, history])).digest("hex").slice(0, 24);
  return new URL(`${history.length}-${key}.json`, CACHE_DIR);
}

async function readCachedLevel(prompt, history) {
  if (!DIAGNOSTICS || history.length >= CACHED_DEPTH) return null;
  try {
    return JSON.parse(await readFile(cacheFile(prompt, history), "utf8"));
  } catch {
    return null;
  }
}

async function cacheLevel(prompt, history, level) {
  if (!DIAGNOSTICS || history.length >= CACHED_DEPTH) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile(prompt, history), JSON.stringify(level));
  } catch (err) {
    console.error("Could not cache level:", err.message);
  }
}

const FONTS = ["/fonts/AnalogMonoPlus.ttf"];

// Spending guard: every level costs Gemini credit, so cap how many the whole
// site can generate per UTC day. In memory, so a restart resets the count.
const DAILY_LEVEL_CAP = Number(process.env.DAILY_LEVEL_CAP) || 200;
let capDay = "";
let levelsToday = 0;

function underDailyCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== capDay) {
    capDay = today;
    levelsToday = 0;
  }
  if (levelsToday >= DAILY_LEVEL_CAP) return false;
  levelsToday += 1;
  return true;
}

async function readJson(req, limit = 20_000) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("Request too large");
  }
  return JSON.parse(body);
}

// The SDK's err.message is opaque; the API's own message is inside err.body.
function apiMessage(err) {
  try {
    const parsed = JSON.parse(err.body);
    const message = (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.message;
    if (message) return message;
  } catch {
    // Not an API error body.
  }
  return err.message || "Generation failed";
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(await readFile(new URL("./public/index.html", import.meta.url)));
  }

  if (req.method === "GET" && FONTS.includes(req.url)) {
    res.writeHead(200, { "Content-Type": "font/ttf", "Cache-Control": "max-age=86400" });
    return res.end(await readFile(new URL("./public" + req.url, import.meta.url)));
  }

  // Layout diagnostics posted by the page, for phone debugging.
  if (DIAGNOSTICS && req.method === "POST" && req.url === "/api/debug") {
    try { console.log("DEBUG", JSON.stringify(await readJson(req))); } catch {}
    return send(res, 200, {});
  }

  if (req.method === "POST" && req.url === "/api/level") {
    let prompt, history;
    try {
      const body = await readJson(req);
      prompt = String(body.prompt || "").trim().slice(0, 300);
      history = (Array.isArray(body.history) ? body.history : []).slice(-8).map((h) => String(h).slice(0, 500));
      if (!prompt) throw new Error("Missing prompt");
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    const cached = await readCachedLevel(prompt, history);
    if (cached) return send(res, 200, cached);
    if (!underDailyCap()) {
      return send(res, 429, { error: "The city is closed for today. Come back tomorrow." });
    }
    try {
      // The story decides what the scene is; the image then illustrates that scene.
      const story = await generateStory(prompt, history);
      const image = await generateImage(story, prompt, history);
      const level = { scene: story.scene, options: story.options, image };
      await cacheLevel(prompt, history, level);
      return send(res, 200, level);
    } catch (err) {
      const message = apiMessage(err);
      console.error("Generation failed:", message);
      return send(res, 502, { error: message });
    }
  }

  send(res, 404, { error: "Not found" });
}).listen(PORT, () => {
  console.log(`Pixel City 3.0 running at http://localhost:${PORT}`);
  console.log(`Story: ${TEXT_MODEL}  Images: ${IMAGE_MODEL}`);
  if (DIAGNOSTICS) console.log("Diagnostics mode: layout reports on, first 3 levels cached in .cache/levels");
});
