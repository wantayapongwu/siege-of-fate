// lib/endpoint.js -- v57: ห่อ endpoint ทุกตัวด้วยรูปแบบเดียวกัน (ด่านกัน DDoS + อ่าน body + จับ error)
//   export default endpoint({ name, limit, burst, maxBody }, async (method, body, headers, query) => [code, out])
// ทำให้ไฟล์ใน api/ สั้นและเหมือนกันหมด แก้ทีเดียวมีผลทุกเส้นทาง
import { guard, sendDenied } from "./guard.js";

export function parseBody(body) {
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body && typeof body === "object" ? body : {};
}

export function endpoint(opts, fn) {
  return async function handler(req, res) {
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    try {
      const denied = await guard(req, opts);
      if (denied) { sendDenied(res, denied); return; }
      const [code, out, extra] = await fn(req.method, parseBody(req.body), req.headers || {}, req.query || {});
      res.setHeader("Cache-Control", "no-store");
      for (const [k, v] of Object.entries(extra || {})) res.setHeader(k, v);
      res.status(code).json(out);
    } catch (e) {
      res.status(500).json({ ok: false, msg: "server error: " + (e && e.message) });
    }
  };
}
