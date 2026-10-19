// api/rooms.js -- Vercel Serverless Function: รายชื่อห้องของ Siege of Fate
//   GET  /api/rooms?proto=sof-v28            -> { ok, rooms: [...], storage, your_ip }
//   POST /api/rooms {action:"register", name, host, port, players, max, proto[, public_host, dedicated]} -> { ok, id, token, ip }
//   POST /api/rooms {action:"heartbeat", id, token, players} | {action:"remove", id, token}
import { handle } from "../lib/lobby.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const [code, out] = await handle(req.method, body || {}, req.headers || {}, req.query || {});
    res.status(code).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, msg: "server error: " + (e && e.message) });
  }
}
