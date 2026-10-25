// api/admin.js -- v35: ข้อมูลหลังบ้านสำหรับผู้ดูแล (ต้องล็อกอินด้วยบัญชีผู้ดูแล) | POST {action, token, ...}
import { handleAdmin } from "../lib/admin.js";
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const [code, out] = await handleAdmin(req.method, body || {}, req.headers || {});
    res.setHeader("X-Robots-Tag", "noindex");
    res.status(code).json(out);
  } catch (e) { res.status(500).json({ ok: false, msg: "server error: " + (e && e.message) }); }
}
