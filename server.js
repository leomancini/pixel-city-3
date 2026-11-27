import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// The whole story is made ahead of time by scripts/generate.mjs and saved in
// levels/. This server only hands out those files: it never calls Gemini, so
// playing costs nothing and needs no API key.
const PORT = process.env.PORT || 3000;

const FONTS = ["/fonts/AnalogMonoPlus.ttf"];

// levels/index.json, c0-d1.json, c0-d1-2-0.jpg and so on.
const LEVEL_FILE = /^\/levels\/(index\.json|c\d+-d\d+(?:-\d)*\.(?:json|jpg))$/;

// Layout diagnostics: only for requests made to this machine by a local
// address (localhost, or its private LAN address for testing from a phone),
// never on the public site, which sits behind a proxy.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)(:\d+)?$/i;
const isLocal = (req) => LOCAL_HOST.test(req.headers.host || "") && !req.headers["x-forwarded-for"];

async function readJson(req, limit = 20_000) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("Request too large");
  }
  return JSON.parse(body);
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  const path = (req.url || "").split("?")[0];

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(await readFile(new URL("./public/index.html", import.meta.url)));
  }

  // Home Screen icon (iOS also asks for the -precomposed name on its own).
  if (req.method === "GET" && /^\/apple-touch-icon(-precomposed)?\.png$/.test(path)) {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
    return res.end(await readFile(new URL("./public/apple-touch-icon.png", import.meta.url)));
  }

  if (req.method === "GET" && FONTS.includes(path)) {
    res.writeHead(200, { "Content-Type": "font/ttf", "Cache-Control": "max-age=86400" });
    return res.end(await readFile(new URL("./public" + path, import.meta.url)));
  }

  const level = req.method === "GET" && LEVEL_FILE.exec(path);
  if (level) {
    try {
      const file = await readFile(new URL("./levels/" + level[1], import.meta.url));
      const picture = level[1].endsWith(".jpg");
      res.writeHead(200, {
        "Content-Type": picture ? "image/jpeg" : "application/json",
        // Pictures are large and change only when the story is rebuilt.
        "Cache-Control": picture ? "max-age=86400" : "no-cache",
      });
      return res.end(file);
    } catch {
      return send(res, 404, { error: "No such level" });
    }
  }

  // Layout diagnostics posted by the page, for phone debugging.
  if (isLocal(req) && req.method === "POST" && path === "/api/debug") {
    try { console.log("DEBUG", JSON.stringify(await readJson(req))); } catch {}
    return send(res, 200, {});
  }

  send(res, 404, { error: "Not found" });
}).listen(PORT, () => {
  console.log(`Pixel City 3.0 running at http://localhost:${PORT}`);
  console.log("Serving the pregenerated story in levels/");
});
