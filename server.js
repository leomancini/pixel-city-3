import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
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
Keep the tone playful and curious, keep it suitable for all ages, and never end the story.`;

const STORY_FORMAT = {
  type: "text",
  mime_type: "application/json",
  schema: {
    type: "object",
    properties: {
      scene: { type: "string" },
      options: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
    },
    required: ["scene", "options"],
  },
};

async function generateStory(prompt, history) {
  const past = history.length
    ? `Story so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n\n`
    : "";
  const interaction = await ai.interactions.create({
    model: TEXT_MODEL,
    system_instruction: STORY_SYSTEM,
    input: `${past}The player chooses: ${prompt}`,
    response_format: STORY_FORMAT,
    store: false,
  });
  const story = JSON.parse(interaction.output_text);
  if (typeof story.scene !== "string" || !Array.isArray(story.options) || story.options.length < 3) {
    throw new Error("Story model returned an unexpected shape");
  }
  return { scene: story.scene, options: story.options.slice(0, 3).map(String) };
}

// One fixed art direction for every level, so the game reads as a single world.
const ART_STYLE = `Highly detailed 16-bit pixel art video game scene.
Camera: always a flat, straight-on side view at street level, like a side-scrolling game background. Orthographic front elevation: the ground is a level horizontal band along the bottom, buildings and objects face the viewer squarely, all horizontal lines are perfectly horizontal and all vertical lines perfectly vertical. No perspective, no vanishing point, no isometric or three-quarter angle, no aerial or tilted view.
Style: crisp fine pixel work with clean dark outlines, flat shading with a little dithering, the same vibrant dusk palette of deep purples and blues with warm window and neon accents. Many small characters and props. No text, no letters, no UI.
Framing: a square, full-bleed image. The scene fills the whole canvas edge to edge on all four sides, with detailed artwork right up to every edge. No border, frame, vignette, letterbox bars, or empty black or blank bands at the top, bottom or sides; the ground or street continues, fully drawn, to the bottom edge.`;

async function generateImage(scene) {
  const interaction = await ai.interactions.create({
    model: IMAGE_MODEL,
    input: `${ART_STYLE} Scene: ${scene}`,
    // The page shows the picture at 256x256, so the smallest size is plenty,
    // and minimal thinking halves the wait and drops the thinking-token cost.
    response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: "1:1", image_size: "512" },
    generation_config: { thinking_level: "minimal" },
    store: false,
  });
  const image = interaction.output_image;
  if (!image?.data) throw new Error("Image model returned no image");
  return `data:${image.mime_type || "image/jpeg"};base64,${image.data}`;
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
    if (!underDailyCap()) {
      return send(res, 429, { error: "The city is closed for today. Come back tomorrow." });
    }
    try {
      // The story decides what the scene is; the image then illustrates that scene.
      const story = await generateStory(prompt, history);
      const image = await generateImage(story.scene);
      return send(res, 200, { ...story, image });
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
});
