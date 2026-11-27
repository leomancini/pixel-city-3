// Builds the game's whole story ahead of time. The site never calls Gemini:
// it only serves what this script wrote to levels/.
//
//   node scripts/generate.mjs --pilot     one level, prints token usage
//   node scripts/generate.mjs             everything (resumes; skips what exists)
//
// Shape: each character has four districts. Each district is a small tree
// (an arrival, three second steps, nine third steps). Every third step ends
// with three ways to travel on, one to each of that character's other
// districts, so a session keeps one character and never runs out of story.
import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";

const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1";
const BUDGET = Number(process.env.BUDGET_USD) || 9.5;
const PILOT = process.argv.includes("--pilot");
const OUT = new URL("../levels/", import.meta.url);
const LEDGER = new URL("../.cache/generate-cost.json", import.meta.url);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// USD per million tokens. Deliberately on the high side, so the real bill
// comes in at or under what this script counts.
const PRICE = {
  text: { input: 0.75, output: 3.75, image: 3.75 },
  image: { input: 1.5, output: 7.5, image: 30 },
};
let ledger = { usd: 0, calls: 0 };
try { ledger = JSON.parse(await readFile(LEDGER, "utf8")); } catch {}
function spend(kind, usage = {}) {
  if (PILOT) console.log(kind, "usage:", JSON.stringify(usage));
  // Picture tokens cost far more than the text and thinking tokens beside them.
  const picture = (usage.output_tokens_by_modality || []).filter((m) => m.modality === "image").reduce((n, m) => n + m.tokens, 0);
  const other = (usage.total_output_tokens || 0) - picture + (usage.total_thought_tokens || 0);
  const price = PRICE[kind];
  ledger.usd += ((usage.total_input_tokens || 0) * price.input + other * price.output + picture * price.image) / 1e6;
  ledger.calls += 1;
}
const saveLedger = async () => {
  await mkdir(new URL("../.cache/", import.meta.url), { recursive: true });
  await writeFile(LEDGER, JSON.stringify(ledger));
};

// One player per session, a different one each time.
const CHARACTERS = [
  "a young Black woman with a round afro, in a bright yellow raincoat and green boots, carrying a red umbrella",
  "an elderly East Asian man with a white beard, in a blue flat cap and orange cardigan, walking with a wooden cane",
  "a South Asian girl with a long black braid, in a teal hoodie, riding a purple wheelchair",
  "a tall Latino man with a moustache, in a red poncho and wide straw hat, carrying a guitar on his back",
  "a Middle Eastern woman in a lilac headscarf and long mustard coat, with a brown satchel over her shoulder",
  "a young boy with messy dark hair and bright blue eyes, in a green striped T-shirt and red sneakers, carrying a skateboard",
  "a teenage boy with dark curly hair, blue eyes and round glasses, in a denim jacket, with a camera around his neck",
  "a lanky boy with straight black hair and blue eyes, in an orange puffer vest and white scarf, with a kite strapped to his back",
  "a silver-haired grandmother with big round glasses, in a pink tracksuit, walking a small white dog on a lead",
  // Plays the East Asian-themed districts; the same person as the roller
  // skater further down, who also has a set of her own.
  "a young Chinese woman with a long black ponytail, in a red bomber jacket and white roller skates",
  "a young Chinese woman with a long black ponytail, in a red bomber jacket and white roller skates",
  "a Korean teenage boy with dyed silver hair, in a mint-green hoodie, with big headphones and a dance bag",
  "a Japanese grandfather with round glasses and a grey moustache, in a navy work apron, pushing a bicycle with a crate of plants",
];

// Four districts per character: [name, how you arrive, what it is like].
const DISTRICTS = [
  [["Neon Harbor", "harbour ferry", "a night port of cranes, fishing boats and glowing fish stalls"],
   ["Rooftop Gardens", "cable car", "greenhouses, beehives and vegetable plots strung across tower rooftops"],
   ["Undercity Market", "subway train", "a crowded underground bazaar lit by lanterns and old signals"],
   ["Clocktower Square", "street tram", "a cobbled square of clockmakers under a giant ticking tower"]],
  [["Canal Quarter", "water taxi", "narrow canals, arched bridges and floating tea houses"],
   ["Arcade Alley", "monorail", "a lane of buzzing game arcades, prize machines and pinball parlours"],
   ["Observatory Hill", "funicular railway", "a hilltop of telescopes, star charts and sleepy astronomers"],
   ["Paper Lantern Row", "rickshaw", "a street of lantern makers, kite shops and dumpling steamers"]],
  [["Sky Dock", "airship", "a high platform where patched airships moor among the clouds"],
   ["Robot Repair Yard", "delivery truck", "a yard of friendly broken robots, spare parts and sparking workbenches"],
   ["Glass Aquarium Hall", "glass elevator", "a vast hall of tanks with glowing jellyfish and a sleepy octopus"],
   ["Candy Foundry", "steam train", "a factory district of sweet smoke, taffy pullers and sugar furnaces"]],
  [["Midnight Carnival", "ferris wheel gondola", "a fairground of striped tents, fortune machines and a carousel"],
   ["Old Library Stacks", "book cart lift", "towering shelves, rolling ladders and whispering librarians"],
   ["Jazz Basement", "night bus", "a smoky-blue cellar club with a brass band and tiny round tables"],
   ["Windmill Flats", "bicycle rickshaw", "a breezy rooftop plain of spinning windmills and laundry lines"]],
  [["Spice Bridge", "river barge", "a covered bridge packed with spice sellers and copper pots"],
   ["Tailors' Arcade", "glass-roofed trolley", "a covered arcade of tailors, looms and bolts of bright cloth"],
   ["Pigeon Post Tower", "spiral lift", "a tall mail tower of pigeon lofts, parcels and brass chutes"],
   ["Hot Spring Terraces", "mountain cable tram", "steaming pools, bathhouses and snack carts on stone terraces"]],
  [["Skate Plaza", "skate-park shuttle", "ramps, graffiti walls and a snack van under buzzing floodlights"],
   ["Comic Book Lane", "double-decker bus", "tiny comic shops, poster walls and a rooftop cartoon cinema"],
   ["Treehouse Heights", "rope-bridge lift", "treehouses, rope bridges and lantern-lit platforms in giant trees"],
   ["Pinball Pier", "paddle steamer", "a pier of pinball halls, ice-cream kiosks and a lighthouse"]],
  [["Photo Bazaar", "night tram", "camera stalls, darkroom tents and walls of drying photographs"],
   ["Radio Tower Roof", "service elevator", "aerials, blinking dishes and a pirate radio studio in a shed"],
   ["Flooded Subway Garden", "rowing boat", "an old station turned water garden, with lilies between the platforms"],
   ["Vinyl Vaults", "freight lift", "underground record shops, listening booths and a spinning neon disc"]],
  [["Kite Hill", "hillside chairlift", "a windy hill of kite flyers, wind socks and a tea hut"],
   ["Snow Globe Works", "sleigh tram", "a workshop street making snow globes, music boxes and wind-up toys"],
   ["Lighthouse Reef", "glass-bottomed boat", "a rocky reef with a lighthouse, tide pools and a seal colony"],
   ["Balloon Fields", "hot-air balloon", "a meadow of tethered balloons, basket weavers and ribbon stalls"]],
  // European-themed, still whimsical and futuristic.
  [["Nouveau Paris Rooftops", "hover metro", "a French quarter of zinc rooftops and cafe terraces, where pastry robots, accordion automatons and a lace-iron tower strung with lights glow under drifting balloons"],
   ["Piazza Nova", "flying scooter", "an Italian piazza of ochre arcades, a marble fountain, gelato carts, pasta-spinning machines, laundry lines and hovering scooters"],
   ["New Albion Clockworks", "double-decker hover bus", "an English street of rainy cobbles, red call boxes that teleport, tea rooms, umbrella stands, bowler-hatted robots and a great clock tower"],
   ["Carnival Canals", "gondola drone", "a Venetian maze of canals and arched bridges, with masked revellers, glassblowers and lantern-lit gondolas that float just above the water"]],
  // East Asian-themed, still whimsical and futuristic.
  [["Dragon Lantern Market", "maglev dragon train", "a Chinese night market of red lanterns, moon gates, tea-pouring robots, steaming dumpling towers and a holographic dragon winding overhead"],
   ["Hanok Sky Village", "cloud cable pod", "a Korean village of curved tiled hanok roofs on floating platforms, with kimchi-jar gardens, rice-cake carts, paper lamps and a hologram pop stage"],
   ["Sakura Circuit Arcade", "bullet train", "a Japanese street of cherry blossoms, neon-lit torii gates, capsule-toy machines, ramen robots and waving lucky-cat machines"],
   ["Jade Junk Harbour", "solar-sail junk", "a harbour of Chinese junks with glowing solar sails, jade-green water, pagoda lighthouses and floating tea barges"]],
  [["Roller Rink Rooftop", "rooftop escalator", "a neon roller rink on a tower roof, with a disco-ball drone, skate rental robots and a bubble-tea bar"],
   ["Cloud Noodle Factory", "noodle-cart monorail", "a factory where noodles are pulled between towers like bridges, with flour clouds, wok robots and tasting counters"],
   ["Panda Cable Park", "bamboo cable car", "a bamboo forest park in the sky, with robot pandas, swinging bridges and a steamed-bun kiosk"],
   ["Firework Workshop Lane", "paper-lantern balloon", "a lane of firework makers, spark-proof robots, paper dragons and test rockets fizzing over tiled roofs"]],
  [["Hologram Dance Studio Row", "light-rail pod", "a street of mirrored dance studios, hologram instructors, sticker-photo booths and a rooftop stage"],
   ["Starlight Convenience Arcade", "moving walkway", "an all-night arcade of glowing convenience stores, instant-noodle bars, claw machines and vending robots"],
   ["Han River Sky Deck", "river hover ferry", "a riverside deck of picnic mats, fried-chicken drones, kite lights and a rainbow fountain bridge"],
   ["Vinyl Karaoke Tower", "glass karaoke lift", "a tower of tiny karaoke rooms, each a different colour, with a robot DJ and a spinning rooftop sign"]],
  [["Bonsai Sky Nursery", "garden tram", "terraces of giant bonsai on floating pots, with watering drones, moss paths and a tea shed"],
   ["Bathhouse Chimney Street", "retro streetcar", "an old street under a tall bathhouse chimney, with steam pipes, wooden clogs, a milk vending robot and sleepy cats"],
   ["Bullet Train Bento Station", "bento express", "a gleaming station of bento stalls, ticket-punching robots, model trains and a clock with dancing figures"],
   ["Koi Canal Workshop", "koi-shaped boat", "a canal of glowing koi, bicycle repair sheds, paper umbrellas drying and a robot heron"]],
];
// Extra districts that are only ever starting points: nothing travels to
// them, and their last steps travel on to the character's main four.
DISTRICTS[0].push(["Moonlit Laundromat", "night bus", "a glowing laundromat of tumbling machines, lost socks and a sleeping cat"]);
DISTRICTS[2].push(["Planetarium Dome", "star shuttle", "a dark dome of projected stars, model planets and reclining seats"]);
DISTRICTS[4].push(["Tea Garden Steps", "garden gondola", "terraced tea bushes, a pavilion and kettles steaming on charcoal"]);

const storySystem = (PLAYER) => `You are the narrator of Pixel City 3.0, an endless choose-your-own-adventure game set in a sprawling, strange, lively pixel-art city.
Given the story so far and the player's latest choice, write what happens next and offer three ways to continue.
The text is shown in a small retro dialogue box, in large type, so keep it very short.

Continuity comes first. This is one continuous story, not a series of unrelated scenes:
- The new scene is the direct, immediate result of the player's latest choice, and says so: someone reading only the previous scene, the choice and the new scene must see how one led to the next.
- The new scene happens where that choice plainly takes the player. A choice about something in front of them plays out right there; a choice to go somewhere (climb, board, enter, follow, ride) arrives at that new place.
- Go inside. When the choice is to board a train, tram, boat, airship or any vehicle, or to enter a shop, tent, tower, workshop or any building, the next scene is the interior: the player is inside it, among its seats, passengers, shelves, machines and windows, and the picture shows that interior, not the outside again.
- Keep the story moving. Every step changes something that matters: a discovery, a new character, a new place. Never offer again an option that was offered before; options not taken are gone, so leave those things out of the new picture unless the story needs them. At least one of the three options leads away to a different place, and the story never lingers in one spot for more than two steps.
- Whatever the player has picked up, whoever is travelling with them, the weather and the time of day all carry over until the story changes them. Refer back to earlier events when it fits.
- The player is always ${PLAYER}.

Fields:
- "scene": at most 12 words, in second person, present tense, describing a single place or moment that would make a good picture. Just the moment: do not end with a question such as "What next?", "Where to?" or "What now?", because the options below already ask it.
- "options": exactly three distinct actions the player could take next. Each has:
  - "label": 2 or 3 short words, starting with a verb, no trailing punctuation. The three lead in genuinely different directions.
  - "shown": 6 to 14 words naming the specific thing in the picture this option acts on, where it is in the picture (far left, left, centre, right, far right, or up high) and the state it is in BEFORE the option is taken. Three different things in three different parts of the picture.
- "picture": 35 to 55 words for the illustrator, never shown to the player, describing exactly what is visible at the moment the question is asked: the place, the player and where they stand, anything carried over from the previous picture, and all three "shown" things. Every wide picture is drawn as a flat side view, like a side-scrolling game: one level ground line along the bottom with everything arranged left to right along it, facing the viewer. Describe it that way, and never mention foreground, background, distance, depth or anything receding.
- "view": "close" or "wide". Use "close" when the player's latest choice was to look closely at, read, study, play or work one particular thing: a notebook, a letter, a map, a game cabinet, a telescope, a puzzle box, a machine's controls. The picture is then a first-person view through the player's eyes, zoomed right in on that thing so it fills the frame, and the scene describes what they see in it. The three options act on parts of that thing or on things lying right beside it, and "shown" says where each sits in the close-up. For a close view the "picture" describes only what is seen up close (the player's own figure is not in it, at most their hands), and the side-view rule below does not apply. Otherwise use "wide". Never use "close" twice in a row: the step after a close view pulls back to "wide".

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
      view: { type: "string", enum: ["wide", "close"] },
    },
    required: ["scene", "options", "picture", "view"],
  },
};

// Drop a stock closing question ("What next?", "Where to now?"): the options
// under the scene already ask it.
function tidyScene(scene) {
  const cut = scene.trim().replace(/(?<=[.!…])\s+(?:\S+\s+){0,4}\S+\?$/, "");
  return cut || scene.trim();
}

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
async function generateStory(player, prompt, history, previous, extra = "") {
  const past = history.length
    ? `Story so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n\n`
    : "";
  const seen = previous?.picture ? `\nThe picture they were looking at: ${previous.picture}` : "";
  const wasClose = previous?.view === "close" ? `\nThat picture was a close view, so this step must be "wide".` : "";
  const offered = previous?.options?.length ? `\nThey were offered: ${previous.options.join("; ")}` : "";
  const interaction = await ai.interactions.create({
    model: TEXT_MODEL,
    system_instruction: storySystem(player),
    // Spell out the question just asked and the answer given, so the next
    // scene follows directly from that exchange.
    input: history.length
      ? `${past}The player was just shown: "${previousScene(history)}"${seen}${offered}\nThe player answered: "${prompt}"\nContinue directly from that answer: show its immediate result, in or leading on from that same picture.${wasClose}${extra}`
      : `${prompt}${extra}`,
    response_format: STORY_FORMAT,
    // Heavy thinking tripled the cost of a level for no visible gain.
    generation_config: { thinking_level: "low" },
    store: false,
  });
  spend("text", interaction.usage);
  const story = JSON.parse(interaction.output_text);
  if (typeof story.scene !== "string" || !Array.isArray(story.options) || story.options.length < 3) {
    throw new Error("Story model returned an unexpected shape");
  }
  story.scene = tidyScene(story.scene);
  const options = story.options.slice(0, 3).map((o) => ({
    label: String(o?.label ?? o),
    shown: typeof o?.shown === "string" ? o.shown : "",
  }));
  return {
    scene: story.scene,
    picture: typeof story.picture === "string" ? story.picture : "",
    // Never two close views running, whatever the model says.
    view: story.view === "close" && previous?.view !== "close" && !extra ? "close" : "wide",
    options,
  };
}

const wideView = (PLAYER) => `
Camera: always a flat, straight-on side view, like a side-scrolling game background, exactly as in the style reference. Orthographic front elevation: the ground or floor is a level horizontal band along the bottom, buildings and objects face the viewer squarely, all horizontal lines are perfectly horizontal and all vertical lines perfectly vertical. No perspective, no vanishing point, no isometric or three-quarter angle, no aerial or tilted view. The same camera indoors, on rooftops, underground and inside vehicles.
Scale: a wide shot, never a close-up. People are small, each about one tenth of the image height, exactly as in the reference, and the place around them fills the picture. Even when the story is about one small object, show the whole place with the object in it. A low space such as a train carriage, corridor, shop or small room is only a few people tall, so it takes up a horizontal band of the picture and the rest of the square is filled with detailed artwork of what lies above and below it, seen through the same flat side view: the storey above with its lit windows, rooftops, signs, sky and skyline; and below, the wheels, tracks, pipes, basement, street or water. Never leave plain dark or empty space above or below the scene.
Player: the player is ${PLAYER}, the same in every picture, about one tenth of the image height, standing on the ground or floor, never a large foreground character.`;

// A first-person look at one thing, for steps where the player reads,
// studies or plays something.
const closeView = (PLAYER) => `
Camera: a first-person close-up. We look through the player's eyes at the one thing they are examining, which fills most of the square and faces the viewer squarely, flat and straight-on, with a little of its surroundings visible around the edges. This is the one case where the style reference's wide camera and small people do not apply; its pixel size, outlines, shading and palette still do.
Scale: the thing is large and drawn in rich detail, so each part of it is easy to make out. Any writing on it appears as tiny illegible marks, symbols or little drawings, never readable letters.
Player: the player's own figure is not in the picture. At most their hands and sleeves reach in from the bottom edge, matching ${PLAYER}.`;

// One fixed art direction for every level, so the game reads as a single
// world. Words alone drift (camera angle, pixel size, how big the people are),
// so every picture is also generated against the same reference image.
const artStyle = (PLAYER, close) => `Draw a new scene for a pixel art video game, in exactly the art style of the STYLE REFERENCE image (the first attached image). The reference shows the style only: match its pixel size, outline weight, shading, colour palette, lighting, level of detail, camera and the scale of its people, but draw the new scene described below from scratch. Do not copy any of the reference's content: not its buildings, shopfronts, tram, tram stop, people or ${close ? closeView(PLAYER) : wideView(PLAYER)}racter.
Style: highly detailed 16-bit pixel art with the reference's fine, uniform pixel size, clean dark outlines, flat shading with a little dithering, and its dusk palette of deep purples and blues with warm window and neon accents, indoors as well as outdoors. Many small characters and props. No text, no letters, no UI.
Framing: a square, full-bleed image. The scene fills the whole canvas edge to edge on all four sides, with detailed artwork right up to every edge. No border, frame, vignette, letterbox bars, or empty black or blank bands at the top, bottom or sides; the ground or street continues, fully drawn, to the bottom edge.`;

const STYLE_REFERENCE = (await readFile(new URL("../art/style-reference.jpg", import.meta.url))).toString("base64");

// A data URL the page sent back, as an image block for the model.
function imageBlock(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  return match ? { type: "image", mime_type: match[1], data: match[2] } : null;
}

async function generateImage(player, { scene, picture, options, view }, prompt, history, previous) {
  const close = view === "close";
  // The previous picture is attached as well as described, so the player,
  // companions, objects and place look the same from one step to the next.
  const last = imageBlock(previous?.image);
  // Tell the picture where the player has just come from and what they chose,
  // so it shows the outcome of that choice rather than an unrelated place.
  const context = history.length
    ? `\nStory so far: ${last ? "the second attached image is the PREVIOUS PICTURE, which" : "the previous picture"} showed "${previousScene(history)}"${previous?.picture ? ` (${previous.picture})` : ""}. The player then chose "${prompt}". The new picture is the next moment of the same story and shows what that choice led to.${last ? " Keep the player, any companions, carried objects, the weather and the time of day looking exactly as they do in the previous picture, drawn at the same size with the same camera. If the story stays in the same place, keep that place recognisably the same, changed by what the choice did. If the story moves somewhere new, draw the new place from scratch, in the same world. The previous picture is a guide to content only: the camera, flatness, pixel sharpness and style come from the style reference, even where the previous picture differs from it, so redraw everything with crisp, hard-edged pixels and never copy any blur or softness, and if the previous picture has dark empty bands along its top or bottom, do not reproduce them: fill the whole square." : " Keep whatever carries over (the same character, companions, objects, weather and time of day)."} Do not simply redraw the previous picture: the new picture must clearly show the result of the choice.`
    : "";
  const zoom = close
    ? `\nThis picture zooms in: it is the close first-person view of the thing the player chose to look at, drawn as that thing appears in the previous picture, only much larger and in more detail.`
    : previous?.view === "close"
      ? `\nThe previous picture was a first-person close-up. Pull back now to the usual wide, flat side view of the place it was in, and draw the player from their description.`
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
      { type: "text", text: `${artStyle(player, close)}${context}${zoom}\nScene: ${scene}${picture ? `\nWhat is visible: ${picture}` : ""}${choices}` },
    ],
    // The page shows the picture small, so the smallest size is plenty, and
    // minimal thinking halves the wait and drops the thinking-token cost.
    response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: "1:1", image_size: "512" },
    generation_config: { thinking_level: "minimal" },
    store: false,
  });
  spend("image", interaction.usage);
  const image = interaction.output_image;
  if (!image?.data) throw new Error("Image model returned no image");
  return image.data;
}


const idOf = (c, d, path) => [`c${c}`, `d${d}`, ...path].join("-");

async function exists(id) {
  try { return JSON.parse(await readFile(new URL(`${id}.json`, OUT), "utf8")); } catch { return null; }
}

// At most this many levels in flight at once.
const LIMIT = 6;
let running = 0;
const queue = [];
async function slot(fn) {
  if (running >= LIMIT) await new Promise((r) => queue.push(r));
  running += 1;
  try { return await fn(); } finally { running -= 1; queue.shift()?.(); }
}

let made = 0, failed = 0, stopped = false;

// Make (or load) one level, then the three behind its options.
async function build(c, d, path, parent, history) {
  const id = idOf(c, d, path);
  const player = CHARACTERS[c];
  const [name, transport, flavour] = DISTRICTS[c][d];
  const last = path.length === 2;
  let node = await exists(id);
  if (!node) {
    if (stopped) return;
    node = await slot(async () => {
      if (ledger.usd >= BUDGET) { stopped = true; return null; }
      // The last step of a district offers travel to the other three.
      // An extra district (4 and up) has four to pick from: leave one out, a
      // different one for each path.
      const main = [0, 1, 2, 3].filter((x) => x !== d);
      const others = last && main.length > 3 ? main.filter((_, i) => i !== (path[0] + path[1]) % 4) : main;
      // Rotate so the same destination is not always the first option.
      const order = last ? others.map((_, i) => others[(i + path[0] + path[1]) % 3]) : [];
      const extra = last
        ? `\nThis is the last step in ${name}. Show the direct result of the player's answer, and make that result open up three ways to travel on, which are the three options, in this order:\n${order
            .map((o, i) => `${i + 1}. by ${DISTRICTS[c][o][1]} to ${DISTRICTS[c][o][0]}`)
            .join("\n")}\nEach option's label is 2 or 3 words starting with a verb and naming that transport or destination. Each transport, or its stop, door, ticket or driver, is plainly visible in the picture, waiting, not yet boarded.`
        : "";
      const prompt = parent
        ? parent.options[path[path.length - 1]]
        : `Begin the story. The player arrives by ${transport} in ${name}: ${flavour}. The scene says they have just stepped off the ${transport} into ${name}, and the ${transport} is visible in the picture. The three options are things to do right here in ${name}. Use the wide view.`;
      const previous = parent && {
        picture: parent.picture,
        options: parent.options,
        view: parent.view,
        image: `data:image/jpeg;base64,${(await readFile(new URL(`${idOf(c, d, path.slice(0, -1))}.jpg`, OUT))).toString("base64")}`,
      };
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const story = await generateStory(player, prompt, history, previous, extra);
          const image = await generateImage(player, story, prompt, history, previous);
          const next = last
            ? order.map((o) => idOf(c, o, []))
            : [0, 1, 2].map((i) => idOf(c, d, [...path, i]));
          const made_ = { id, scene: story.scene, options: story.options.map((o) => o.label), next, picture: story.picture, shown: story.options.map((o) => o.shown), view: story.view };
          await writeFile(new URL(`${id}.jpg`, OUT), Buffer.from(image, "base64"));
          await writeFile(new URL(`${id}.json`, OUT), JSON.stringify(made_, null, 1));
          made += 1;
          await saveLedger();
          console.log(`${id}  $${ledger.usd.toFixed(2)}  ${story.scene}  [${made_.options.join(" | ")}]`);
          return made_;
        } catch (err) {
          console.error(`${id} attempt ${attempt} failed: ${String(err.message).slice(0, 200)}`);
          await saveLedger();
          await new Promise((r) => setTimeout(r, 4000 * attempt));
        }
      }
      failed += 1;
      return null;
    });
  }
  if (!node || last || PILOT) return;
  await Promise.all([0, 1, 2].map((i) =>
    build(c, d, [...path, i], node, [...history, `Player chose: ${path.length ? parent.options[path[path.length - 1]] : "to arrive"} Then: ${node.scene}`])));
}

async function levelsOf(c) {
  const ids = [];
  for (let d = 0; d < DISTRICTS[c].length; d++) {
    for (const path of [[], ...[0, 1, 2].map((i) => [i]), ...[0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => [i, j]))]) {
      if (await exists(idOf(c, d, path))) ids.push(idOf(c, d, path));
    }
  }
  return ids;
}

// Only characters whose every level exists can be played.
async function writeIndex() {
  const starts = [];
  for (let c = 0; c < CHARACTERS.length; c++) {
    if ((await levelsOf(c)).length === DISTRICTS[c].length * 13) for (let d = 0; d < DISTRICTS[c].length; d++) starts.push(idOf(c, d, []));
  }
  await writeFile(new URL("index.json", OUT), JSON.stringify({ starts }));
  // Everything in one file for the gallery page: who plays where, and every
  // playable level's text and links.
  const characters = [];
  const levels = {};
  for (let c = 0; c < CHARACTERS.length; c++) {
    const ids = await levelsOf(c);
    if (ids.length !== DISTRICTS[c].length * 13) continue;
    characters.push({
      id: `c${c}`,
      player: CHARACTERS[c],
      districts: DISTRICTS[c].map(([name, transport, about], d) => ({ id: idOf(c, d, []), name, transport, about })),
    });
    for (const id of ids) {
      const { scene, options, next, picture, shown, view } = await exists(id);
      levels[id] = { scene, options, next, picture, shown, view };
    }
  }
  await writeFile(new URL("gallery.json", OUT), JSON.stringify({ characters, levels }));
}

await mkdir(OUT, { recursive: true });
const startedAt = ledger.usd;
if (PILOT) {
  await build(0, 0, [], null, []);
} else if (process.argv.includes("--index")) {
  // Only rewrite index.json and gallery.json from what is already on disk.
} else {
  // Arrivals first, so every district exists before anything links to it.
  // One character at a time, and only if the budget covers all of theirs:
  // a half-built character would leave options that lead nowhere.
  for (let c = 0; c < CHARACTERS.length; c++) {
    const missing = DISTRICTS[c].length * 13 - (await levelsOf(c)).length;
    const each = made ? (ledger.usd - startedAt) / made : 0.04;
    if (missing && ledger.usd + missing * each > BUDGET) {
      console.log(`Skipping character ${c}: ${missing} levels at about $${each.toFixed(3)} would pass the budget`);
      continue;
    }
    await Promise.all(DISTRICTS[c].map((_, d) => build(c, d, [], null, [])));
    // Each finished character becomes playable straight away.
    await writeIndex();
  }
}
await writeIndex();
await saveLedger();
console.log(`\nMade ${made}, failed ${failed}, ${stopped ? "STOPPED at budget, " : ""}counted spend $${ledger.usd.toFixed(2)} over ${ledger.calls} calls`);
