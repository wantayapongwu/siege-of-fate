// lib/guard.js -- v57: ด่านกัน DDoS / ยิงคำขอรัว ของ API ล็อบบี้ทั้งหมด
//
// ทำงาน 3 ชั้น เรียงจากถูกไปแพง (ชั้นแรกไม่แตะฐานข้อมูลเลย):
//   1) แคชในหน่วยความจำของอินสแตนซ์: IP ที่โดนแบนอยู่ -> ตอบ 429 ทันที ไม่เสียโควตา Redis
//   2) เบรกเกอร์ระยะสั้น (burst) ต่ออินสแตนซ์: ยิงรัวเกิน BURST ครั้งใน 10 วิ = ตัดทันที
//   3) หน้าต่างนับรวมทุกอินสแตนซ์ (Redis): เกินโควตาต่อนาที = แบนชั่วคราวแบบทวีคูณ
//      (ครั้งแรก 1 นาที -> 2 -> 4 -> 8 ... สูงสุด 60 นาที) แบนถูกจำไว้ทั้งใน Redis และในหน่วยความจำ
//
// ป้องกันเพิ่มเติม: เมธอดที่ไม่รองรับ, ข้อมูลใหญ่เกิน (body), ชนิดข้อมูลผิด, คำขอไม่มี IP
//
// หมายเหตุ: ชั้นเครือข่ายจริง (SYN flood / UDP flood / L3-L4) Vercel รับให้อยู่แล้วที่ขอบเครือข่าย
//          ไฟล์นี้กันชั้นแอป (L7) ซึ่งเป็นชั้นที่ทำให้โควตา/ค่าใช้จ่ายบานปลายและเซิร์ฟเวอร์ล่ม
import * as store from "./store.js";

export const DEFAULTS = {
  limit: 60,          // คำขอต่อหน้าต่าง (ต่อ IP)
  windowSec: 60,
  burst: 25,          // คำขอต่อ 10 วินาที (ต่ออินสแตนซ์) — ยิงรัวระดับสคริปต์
  maxBody: 64 * 1024, // ขนาดข้อมูลสูงสุดต่อคำขอ
  methods: ["GET", "POST", "OPTIONS", "HEAD"],
};

export const BAN_STEPS = [60, 120, 240, 480, 960, 1920, 3600]; // วินาที (ทวีคูณจนสูงสุด 1 ชม.)
const BURST_WINDOW_MS = 10000;

// สถานะในหน่วยความจำของอินสแตนซ์ (หายตอนอินสแตนซ์ถูกรีไซเคิล = ปลอดภัย ไม่สะสม)
const mem = globalThis.__sofGuard || (globalThis.__sofGuard = { burst: new Map(), ban: new Map(), stats: { checked: 0, blocked: 0, banned: 0 } });

export function clientIp(headers = {}) {
  const xf = String(headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xf || String(headers["x-real-ip"] || "").trim() || "";
  return ip.replace(/^::ffff:/, "");
}

/** ขนาดข้อมูลที่ส่งมา (ไบต์) — ดูจากเฮดเดอร์ก่อน ถ้าไม่มีค่อยวัดจากตัวข้อมูล */
export function bodySize(headers = {}, body) {
  const n = Number(headers["content-length"] || 0);
  if (n > 0) return n;
  if (body == null) return 0;
  try {
    return Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  } catch {
    return 0;
  }
}

function now() { return Date.now(); }

/** IP นี้โดนแบนอยู่ไหม (ดูจากหน่วยความจำก่อน ไม่เจอค่อยถาม Redis) */
export async function banLeft(ip) {
  const until = mem.ban.get(ip) || 0;
  if (until > now()) return Math.ceil((until - now()) / 1000);
  if (until) mem.ban.delete(ip);
  const v = await store.get("sof:ban:" + ip);
  if (!v) return 0;
  const left = Math.ceil((Number(v) - now()) / 1000);
  if (left <= 0) return 0;
  mem.ban.set(ip, Number(v));
  return left;
}

/** แบน IP แบบทวีคูณ (ยิ่งโดนซ้ำยิ่งนาน) -> คืนจำนวนวินาทีที่แบน */
export async function ban(ip) {
  const strikes = await store.hit("sof:strike:" + ip, 3600);
  const sec = BAN_STEPS[Math.min(strikes - 1, BAN_STEPS.length - 1)] || BAN_STEPS[0];
  const until = now() + sec * 1000;
  mem.ban.set(ip, until);
  await store.setex("sof:ban:" + ip, sec, String(until));
  mem.stats.banned++;
  return sec;
}

/** ตัวนับยิงรัวในอินสแตนซ์นี้ (10 วินาที) */
function burstHit(ip) {
  const t = now();
  const e = mem.burst.get(ip);
  if (!e || e.reset < t) {
    mem.burst.set(ip, { n: 1, reset: t + BURST_WINDOW_MS });
    if (mem.burst.size > 5000) {           // กันหน่วยความจำบวมตอนโดนยิงจากหลายพัน IP
      for (const [k, v] of mem.burst) if (v.reset < t) mem.burst.delete(k);
    }
    return 1;
  }
  e.n++;
  return e.n;
}

/**
 * ด่านหลัก — เรียกเป็นบรรทัดแรกของทุก endpoint
 * @returns {Promise<null|[number, object, object]>} null = ผ่าน | [status, body, headers] = ตัดทิ้ง
 */
export async function guard(req, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const headers = req.headers || {};
  const ip = clientIp(headers);
  mem.stats.checked++;
  const method = String(req.method || "GET").toUpperCase();
  if (!o.methods.includes(method)) return deny(405, "method not allowed");
  if (method === "OPTIONS" || method === "HEAD") return null;   // preflight ไม่ต้องนับ
  if (!ip) return deny(400, "no ip");

  // v76.9: คำขอที่ไม่ใช่รูปแบบของเกม -> ตัดทิ้งก่อนเสียเวลาประมวลผล
  const url = String(req.url || "");
  if (url.length > 1024) return deny(414, "url too long");
  if (method === "POST") {
    const ct = String(headers["content-type"] || "").toLowerCase();
    if (ct && !ct.includes("application/json") && !ct.includes("text/plain"))
      return deny(415, "unsupported content type");
  }

  const left = await banLeft(ip);
  if (left > 0) return deny(429, "ถูกระงับชั่วคราวจากการส่งคำขอถี่ผิดปกติ", { "Retry-After": String(left) });

  const size = bodySize(headers, req.body);
  if (size > o.maxBody) return deny(413, "ข้อมูลใหญ่เกินกำหนด");

  if (burstHit(ip) > o.burst) {
    const sec = await ban(ip);
    return deny(429, "ส่งคำขอถี่เกินไป", { "Retry-After": String(sec) });
  }

  const key = "sof:g:" + (o.name || "all") + ":" + ip;
  const n = await store.hit(key, o.windowSec);
  if (n > o.limit) {
    // เกินโควตาเกินเท่าตัว = ตั้งใจยิง -> แบน | เกินนิดหน่อย = แค่ปฏิเสธคำขอนี้
    if (n > o.limit * 2) {
      const sec = await ban(ip);
      return deny(429, "ส่งคำขอถี่เกินไป", { "Retry-After": String(sec) });
    }
    return deny(429, "ส่งคำขอถี่เกินไป ลองใหม่ภายหลัง", { "Retry-After": String(o.windowSec) });
  }
  return null;
}

function deny(code, msg, extra = {}) {
  mem.stats.blocked++;
  return [code, { ok: false, msg }, { "Cache-Control": "no-store", ...extra }];
}

/** ส่งคำตอบของด่าน (ใช้ร่วมกับ guard) */
export function sendDenied(res, denied) {
  const [code, body, headers] = denied;
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
  res.status(code).json(body);
}

export function stats() {
  return { ...mem.stats, tracked_ips: mem.burst.size, banned_now: [...mem.ban.values()].filter((t) => t > now()).length };
}

export function _reset() {
  mem.burst.clear();
  mem.ban.clear();
  mem.stats = { checked: 0, blocked: 0, banned: 0 };
}
