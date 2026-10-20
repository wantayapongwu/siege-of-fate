// api/save.js -- เซฟตัวละครบนเซิร์ฟเวอร์ (v30): POST {action:"get"|"put", token, save}
import { handleSave } from "../lib/save.js";
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const [code, out] = await handleSave(req.method, body || {});
    res.status(code).json(out);
  } catch (e) { res.status(500).json({ ok: false, msg: "server error: " + (e && e.message) }); }
}
