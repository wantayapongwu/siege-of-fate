// api/gstash.js -- คลังกิลล์ร่วมกัน (v38): POST {action:"get"|"put"|"take", token, gid, ...}
import { handleGStash } from "../lib/gstash.js";
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const [code, out] = await handleGStash(req.method, body || {});
    res.status(code).json(out);
  } catch (e) { res.status(500).json({ ok: false, msg: "server error: " + (e && e.message) }); }
}
