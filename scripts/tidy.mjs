// One-off pass over levels already generated: drops stock closing questions.
import { readdir, readFile, writeFile } from "node:fs/promises";
const dir = new URL("../levels/", import.meta.url);
let changed = 0, kept = [];
for (const name of await readdir(dir)) {
  if (!/^c\d.*\.json$/.test(name)) continue;
  const level = JSON.parse(await readFile(new URL(name, dir), "utf8"));
  const cut = level.scene.trim().replace(/(?<=[.!…])\s+(?:\S+\s+){0,4}\S+\?$/, "") || level.scene.trim();
  if (cut !== level.scene) { level.scene = cut; changed++; await writeFile(new URL(name, dir), JSON.stringify(level, null, 1)); }
  if (cut.endsWith("?")) kept.push(cut);
}
console.log(`changed ${changed}; still ending in a question: ${kept.length}`);
console.log(kept.slice(0, 12).join("\n"));
