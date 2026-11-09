// api/stripe_webhook.js -- v41: Stripe เรียกเข้ามาเมื่อจ่ายเงินสำเร็จ/ล้มเหลว
// ตั้งค่าใน Stripe Dashboard -> Developers -> Webhooks -> endpoint: https://<โดเมน>/api/stripe_webhook
//   เหตุการณ์: checkout.session.completed, checkout.session.async_payment_succeeded,
//              checkout.session.async_payment_failed, checkout.session.expired
// ต้องอ่าน body ดิบ (ไม่ให้ Vercel แปลง JSON) เพราะลายเซ็นคำนวณจากตัวอักษรดิบ
import { handleWebhook } from "../lib/shop.js";

export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    const raw = typeof req.body === "string" ? req.body : await readRaw(req);
    const [code, out] = await handleWebhook(req.method, raw, req.headers || {});
    res.setHeader("Cache-Control", "no-store");
    res.status(code).json(out);
  } catch (e) { res.status(500).json({ ok: false, msg: "server error: " + (e && e.message) }); }
}
