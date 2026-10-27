// api/shop.js -- v41: ร้านคอสตูมเงินจริง | POST {action, token, ...}
import { handleShop } from "../lib/shop.js";
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const [code, out] = await handleShop(req.method, body || {}, req.headers || {});
    res.setHeader("Cache-Control", "no-store");
    res.status(code).json(out);
  } catch (e) { res.status(500).json({ ok: false, msg: "server error: " + (e && e.message) }); }
}
