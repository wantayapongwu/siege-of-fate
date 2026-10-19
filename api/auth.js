// api/auth.js -- POST {action:"register"|"login", user, pass} | {action:"me", token}
import { handleAuth } from "../lib/accounts.js";
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const [code, out] = await handleAuth(req.method, body || {}, req.headers || {});
    res.status(code).json(out);
  } catch (e) { res.status(500).json({ ok: false, msg: "server error: " + (e && e.message) }); }
}
