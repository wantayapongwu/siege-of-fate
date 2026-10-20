// dev_server.js -- รันล็อบบี้บนเครื่องตัวเองโดยไม่ต้องใช้ Vercel (ทดสอบ): node dev_server.js [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./lib/lobby.js";
import { handleAuth } from "./lib/accounts.js";
import { handleSignal } from "./lib/signal.js";
import { handleSave } from "./lib/save.js";
import { storageKind } from "./lib/store.js";

const dir = process.env.SOF_PUBLIC_DIR ? path.dirname(process.env.SOF_PUBLIC_DIR) : path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8787);
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(obj)); };
  if (u.pathname === "/api/health") return send(200, { ok: true, storage: storageKind() });
  const routes = { "/api/rooms": (m, b, h, q) => handle(m, b, h, q), "/api/auth": (m, b, h) => handleAuth(m, b, h), "/api/signal": (m, b, h) => handleSignal(m, b, h), "/api/save": (m, b) => handleSave(m, b) };
  if (routes[u.pathname]) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const headers = { ...req.headers, "x-forwarded-for": req.headers["x-forwarded-for"] || req.socket.remoteAddress };
      const [code, out] = await routes[u.pathname](req.method, body, headers, Object.fromEntries(u.searchParams));
      send(code, out);
    });
    return;
  }
  const f = path.join(dir, "public", u.pathname === "/" ? "index.html" : u.pathname);
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".png": "image/png", ".pck": "application/octet-stream", ".json": "application/json" };
  if (f.startsWith(path.join(dir, "public")) && fs.existsSync(f)) { res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f)); return; }
  send(404, { ok: false });
}).listen(port, () => console.log("[lobby] http://127.0.0.1:" + port + " (storage: " + storageKind() + ")"));
