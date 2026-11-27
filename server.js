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

// The player looks the same in every picture, so the story reads as one
// person's journey.
const PLAYER = "a small figure in a bright red hooded jacket with a yellow backpack";

const STORY_SYSTEM = `You are the narrator of Pixel City 3.0, an endless choose-your-own-adventure game set in a sprawling, strange, lively pixel-art city.
Given the story so far and the player's latest choice, write what happens next and offer three ways to continue.
The text is shown in a small retro dialogue box, in large type, so keep it very short.

Continuity comes first. This is one continuous story, not a series of unrelated scenes:
- The new scene is the direct, immediate result of the player's latest choice, and says so: someone reading only the previous scene, the choice and the new scene must see how one led to the next.
- The new scene happens where that choice plainly takes the player. A choice about something in front of them plays out right there; a choice to go somewhere (climb, board, enter, follow, ride) arrives at that new place.
- Keep the story moving. Every step changes something that matters: a discovery, a new character, a new place. Never offer again an option that was offered before; options not taken are gone, so leave those things out of the new picture unless the story needs them. At least one of the three options leads away to a different place, and the story never lingers in one spot for more than two steps.
- Whatever the player has picked up, whoever is travelling with them, the weather and the time of day all carry over until the story changes them. Refer back to earlier events when it fits.
- The player is always ${PLAYER}.

Fields:
- "scene": at most 12 words, in second person, present tense, describing a single place or moment that would make a good picture, ending with a short question about what to do.
- "options": exactly three distinct actions the player could take next. Each has:
  - "label": 2 or 3 short words, starting with a verb, no trailing punctuation. The three lead in genuinely different directions.
  - "shown": 6 to 14 words naming the specific thing in the picture this option acts on, where it is in the picture (far left, left, centre, right, far right, or up high) and the state it is in BEFORE the option is taken. Three different things in three different parts of the picture.
- "picture": 35 to 55 words for the illustrator, never shown to the player, describing exactly what is visible at the moment the question is asked: the place, the player and where they stand, anything carried over from the previous picture, and all three "shown" things. Every picture is drawn as a flat side view, like a side-scrolling game: one level ground line along the bottom with everything arranged left to right along it, facing the viewer. Describe it that way, and never mention foreground, background, distance, depth or anything receding.

The picture and the options must agree. Every option refers to something plainly visible in the picture, in its state before the option is taken: if an option is "Open garage door", the garage door is there and shut; if an option is "Board the tram", the tram is waiting with the player still on the platform. Never offer an option about something that is not in the picture, or that the picture shows as already done or impossible. Do not offer vague options with nothing to draw ("Look around", "Keep going"): name the thing.
Keep the tone playful and curious, keep it suitable for all ages, and never end the story.`;

const STORY_FORMAT = {
  type: "text",
  mime_type: "application/json",
  schema: {
    type: "object",
    properties: {
      scene: { type: "string" },
      options: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          properties: { label: { type: "string" }, shown: { type: "string" } },
          required: ["label", "shown"],
        },
      },
      picture: { type: "string" },
    },
    required: ["scene", "options", "picture"],
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

// `previous` is the level the player was looking at when they chose: its
// picture description, the options it offered and the picture itself.
async function generateStory(prompt, history, previous) {
  const past = history.length
    ? `Story so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n\n`
    : "";
  const seen = previous?.picture ? `\nThe picture they were looking at: ${previous.picture}` : "";
  const offered = previous?.options?.length ? `\nThey were offered: ${previous.options.join("; ")}` : "";
  const interaction = await ai.interactions.create({
    model: TEXT_MODEL,
    system_instruction: STORY_SYSTEM,
    // Spell out the question just asked and the answer given, so the next
    // scene follows directly from that exchange.
    input: history.length
      ? `${past}The player was just shown: "${previousScene(history)}"${seen}${offered}\nThe player answered: "${prompt}"\nContinue directly from that answer: show its immediate result, in or leading on from that same picture.`
      : `${past}The player chooses: ${prompt}`,
    response_format: STORY_FORMAT,
    store: false,
  });
  const story = JSON.parse(interaction.output_text);
  if (typeof story.scene !== "string" || !Array.isArray(story.options) || story.options.length < 3) {
    throw new Error("Story model returned an unexpected shape");
  }
  const options = story.options.slice(0, 3).map((o) => ({
    label: String(o?.label ?? o),
    shown: typeof o?.shown === "string" ? o.shown : "",
  }));
  return {
    scene: story.scene,
    picture: typeof story.picture === "string" ? story.picture : "",
    options,
  };
}

// One fixed art direction for every level, so the game reads as a single
// world. Words alone drift (camera angle, pixel size, how big the people are),
// so every picture is also generated against the same reference image.
const ART_STYLE = `Draw a new scene for a pixel art video game, in exactly the art style of the STYLE REFERENCE image (the first attached image). The reference shows the style only: match its pixel size, outline weight, shading, colour palette, lighting, level of detail, camera and the scale of its people, but draw the new scene described below from scratch. Do not copy any of the reference's content: not its buildings, shopfronts, tram, tram stop, people or layout.
Camera: always a flat, straight-on side view, like a side-scrolling game background, exactly as in the style reference. Orthographic front elevation: the ground or floor is a level horizontal band along the bottom, buildings and objects face the viewer squarely, all horizontal lines are perfectly horizontal and all vertical lines perfectly vertical. No perspective, no vanishing point, no isometric or three-quarter angle, no aerial or tilted view. The same camera indoors, on rooftops, underground and inside vehicles.
Scale: a wide shot, never a close-up. People are small, each about one tenth of the image height, exactly as in the reference, and the place around them fills the picture. Even when the story is about one small object, show the whole place with the object in it. A low space such as a train carriage, corridor, shop or small room is only a few people tall, so it takes up a horizontal band of the picture and the rest of the square is filled with detailed artwork of what lies above and below it, seen through the same flat side view: the storey above with its lit windows, rooftops, signs, sky and skyline; and below, the wheels, tracks, pipes, basement, street or water. Never leave plain dark or empty space above or below the scene.
Player: the player is ${PLAYER}, the same in every picture, about one tenth of the image height, standing on the ground or floor, never a large foreground character.
Style: highly detailed 16-bit pixel art with the reference's fine, uniform pixel size, clean dark outlines, flat shading with a little dithering, and its dusk palette of deep purples and blues with warm window and neon accents, indoors as well as outdoors. Many small characters and props. No text, no letters, no UI.
Framing: a square, full-bleed image. The scene fills the whole canvas edge to edge on all four sides, with detailed artwork right up to every edge. No border, frame, vignette, letterbox bars, or empty black or blank bands at the top, bottom or sides; the ground or street continues, fully drawn, to the bottom edge.`;

const STYLE_REFERENCE = (await readFile(new URL("./art/style-reference.jpg", import.meta.url))).toString("base64");

// A data URL the page sent back, as an image block for the model.
function imageBlock(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  return match ? { type: "image", mime_type: match[1], data: match[2] } : null;
}

async function generateImage({ scene, picture, options }, prompt, history, previous) {
  // The previous picture is attached as well as described, so the player,
  // companions, objects and place look the same from one step to the next.
  const last = imageBlock(previous?.image);
  // Tell the picture where the player has just come from and what they chose,
  // so it shows the outcome of that choice rather than an unrelated place.
  const context = history.length
    ? `\nStory so far: ${last ? "the second attached image is the PREVIOUS PICTURE, which" : "the previous picture"} showed "${previousScene(history)}"${previous?.picture ? ` (${previous.picture})` : ""}. The player then chose "${prompt}". The new picture is the next moment of the same story and shows what that choice led to.${last ? " Keep the player, any companions, carried objects, the weather and the time of day looking exactly as they do in the previous picture, drawn at the same size with the same camera. If the story stays in the same place, keep that place recognisably the same, changed by what the choice did. If the story moves somewhere new, draw the new place from scratch, in the same world. The previous picture is a guide to content only: the camera, flatness, pixel sharpness and style come from the style reference, even where the previous picture differs from it, so redraw everything with crisp, hard-edged pixels and never copy any blur or softness, and if the previous picture has dark empty bands along its top or bottom, do not reproduce them: fill the whole square." : " Keep whatever carries over (the same character, companions, objects, weather and time of day)."} Do not simply redraw the previous picture: the new picture must clearly show the result of the choice.`
    : "";
  // The picture has to agree with the choices offered under it: each one's
  // subject is drawn, and a door the player can "open" is drawn shut.
  const choices = `\nThe player will next choose one of these three options, so the picture must clearly show the subject of each one, large enough to recognise, each in a different part of the picture:\n${options
    .map((o, i) => `${i + 1}. "${o.label}"${o.shown ? `: ${o.shown}` : ""}`)
    .join("\n")}\nNone of these has happened yet. Show the moment before: all three subjects are visible and still in their untouched state.`;
  const interaction = await ai.interactions.create({
    model: IMAGE_MODEL,
    input: [
      { type: "image", mime_type: "image/jpeg", data: STYLE_REFERENCE },
      ...(history.length && last ? [last] : []),
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

// Diagnostics and sample mode: only for requests made to this machine by a
// local address (localhost, or its private LAN address for testing from a
// phone), never on the public site. It accepts the page's layout reports and
// keeps the first three levels of the story on disk, so reloading the page
// does not regenerate (and pay for) them.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)(:\d+)?$/i;
const isLocal = (req) => LOCAL_HOST.test(req.headers.host || "") && !req.headers["x-forwarded-for"];
const CACHE_DIR = new URL("./.cache/levels/", import.meta.url);
const CACHED_DEPTH = 3;

function cacheFile(prompt, history) {
  const key = createHash("sha256").update(JSON.stringify([prompt, history])).digest("hex").slice(0, 24);
  return new URL(`${history.length}-${key}.json`, CACHE_DIR);
}

async function readCachedLevel(local, prompt, history) {
  if (!local || history.length >= CACHED_DEPTH) return null;
  try {
    return JSON.parse(await readFile(cacheFile(prompt, history), "utf8"));
  } catch {
    return null;
  }
}

async function cacheLevel(local, prompt, history, level) {
  if (!local || history.length >= CACHED_DEPTH) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile(prompt, history), JSON.stringify(level));
  } catch (err) {
    console.error("Could not cache level:", err.message);
  }
}

const FONTS = ["/fonts/AnalogMonoPlus.ttf"];

// Spending guard: every level costs Gemini credit, so cap how many the whole
// site can generate per UTC day. The count is saved to a file so it survives
// restarts, and can be reset with POST /api/admin/reset-cap from the server itself.
const DAILY_LEVEL_CAP = Number(process.env.DAILY_LEVEL_CAP) || 200;
const CAP_FILE = new URL("./.cache/daily-cap.json", import.meta.url);
let capDay = "";
let levelsToday = 0;

try {
  ({ day: capDay, count: levelsToday } = JSON.parse(await readFile(CAP_FILE, "utf8")));
} catch {
  // No saved count yet.
}

async function saveCap() {
  try {
    await mkdir(new URL("./.cache/", import.meta.url), { recursive: true });
    await writeFile(CAP_FILE, JSON.stringify({ day: capDay, count: levelsToday }));
  } catch (err) {
    console.error("Could not save daily cap:", err.message);
  }
}

function underDailyCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== capDay) {
    capDay = today;
    levelsToday = 0;
  }
  if (levelsToday >= DAILY_LEVEL_CAP) return false;
  levelsToday += 1;
  saveCap();
  return true;
}

// Admin endpoints only answer requests made on the server itself: a loopback
// connection that didn't come through the reverse proxy (which adds
// x-forwarded-for). Run them over ssh with curl against localhost.
function isAdmin(req) {
  const addr = req.socket.remoteAddress || "";
  const loopback = addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
  return loopback && !req.headers["x-forwarded-for"] && !req.headers["x-real-ip"];
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

  // Home Screen icon (iOS also asks for the -precomposed name on its own).
  if (req.method === "GET" && /^\/apple-touch-icon(-precomposed)?\.png$/.test(req.url.split("?")[0])) {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
    return res.end(await readFile(new URL("./public/apple-touch-icon.png", import.meta.url)));
  }

  if (req.method === "GET" && FONTS.includes(req.url)) {
    res.writeHead(200, { "Content-Type": "font/ttf", "Cache-Control": "max-age=86400" });
    return res.end(await readFile(new URL("./public" + req.url, import.meta.url)));
  }

  // Layout diagnostics posted by the page, for phone debugging.
  if (isLocal(req) && req.method === "POST" && req.url === "/api/debug") {
    try { console.log("DEBUG", JSON.stringify(await readJson(req))); } catch {}
    return send(res, 200, {});
  }

  if (req.url === "/api/admin/cap" || req.url === "/api/admin/reset-cap") {
    if (!isAdmin(req)) return send(res, 403, { error: "Only available on the server itself" });
    if (req.method === "POST" && req.url === "/api/admin/reset-cap") {
      capDay = new Date().toISOString().slice(0, 10);
      levelsToday = 0;
      await saveCap();
      console.log("Daily cap reset");
    }
    return send(res, 200, { day: capDay, used: levelsToday, cap: DAILY_LEVEL_CAP });
  }

  if (req.method === "POST" && req.url === "/api/level") {
    let prompt, history, previous;
    try {
      // The body carries the previous picture, so it is far larger than text.
      const body = await readJson(req, 1_500_000);
      const before = body.previous && typeof body.previous === "object" ? body.previous : null;
      previous = before && {
        picture: String(before.picture || "").slice(0, 800),
        options: (Array.isArray(before.options) ? before.options : []).slice(0, 3).map((o) => String(o).slice(0, 60)),
        image: typeof before.image === "string" ? before.image : "",
      };
      prompt = String(body.prompt || "").trim().slice(0, 300);
      history = (Array.isArray(body.history) ? body.history : []).slice(-8).map((h) => String(h).slice(0, 500));
      if (!prompt) throw new Error("Missing prompt");
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    const local = isLocal(req);
    const cached = await readCachedLevel(local, prompt, history);
    if (cached) return send(res, 200, cached);
    if (!underDailyCap()) {
      return send(res, 429, { error: "The city is closed for today. Come back tomorrow." });
    }
    try {
      // The story decides what the scene is; the image then illustrates that scene.
      const story = await generateStory(prompt, history, previous);
      const image = await generateImage(story, prompt, history, previous);
      // `picture` goes back to the page only so it can return it as `previous`.
      const level = { scene: story.scene, options: story.options.map((o) => o.label), picture: story.picture, image };
      await cacheLevel(local, prompt, history, level);
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
  console.log("Local requests only: layout reports on, first 3 levels cached in .cache/levels");
});
