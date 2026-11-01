// lib/bans.js -- v79.2: ระงับบัญชี (แบนมือจากหน้า /admin + แบนอัตโนมัติเมื่อส่งเซฟที่เป็นไปไม่ได้ซ้ำๆ)
//
// แบนแล้วเกิดอะไรขึ้น:
//   - ล็อกอินไม่ได้ (ตอบ 403 พร้อมเหตุผลและเวลาที่ปลด)
//   - token เดิมที่ยังค้างอยู่ก็ใช้โหลด/อัปเซฟไม่ได้ (ตรวจที่ /api/save อีกชั้น)
//   - ข้อมูลไม่ถูกลบ -> ปลดแบนแล้วเล่นต่อได้เหมือนเดิม
//
// แบนอัตโนมัติ: นับจาก "ธง" ที่เกิดจากเซฟถูกปฏิเสธ (lib/anticheat.js)
//   ธงที่เกิดจากของซ้ำ uid ไม่นับ เพราะเทรดปกติก็ทำให้ของย้ายเจ้าของได้
//   ตั้งเพดานด้วย env SOF_AUTOBAN_FLAGS (ค่าเริ่มต้น 5) | ปิดด้วย SOF_AUTOBAN=0
//   บัญชีผู้ดูแลและบัญชีใน SOF_ANTICHEAT_EXEMPT ไม่ถูกแบนอัตโนมัติ
import * as store from "./store.js";
import { BANIP_TTL } from "./accounts.js";

const KEY = (u) => "sof:ban:" + String(u).toLowerCase();

export const AUTO_REASON = "ส่งเซฟที่เป็นไปไม่ได้ซ้ำหลายครั้ง";

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

export function autoBanFlags() {
  const n = Number(process.env.SOF_AUTOBAN_FLAGS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
}

export function autoBanOn() {
  return String(process.env.SOF_AUTOBAN || "") !== "0";
}

/** null = ไม่ถูกแบน | {user, at, by, reason, until} (until 0 = ถาวร) */
export async function banInfo(user) {
  const rec = parse(await store.get(KEY(user)));
  if (!rec) return null;
  const until = Number(rec.until) || 0;
  if (until > 0 && Date.now() >= until) {        // แบนชั่วคราวหมดเวลาแล้ว -> ปลดให้เอง
    await store.del(KEY(user));
    return null;
  }
  return rec;
}

export function banMessage(rec) {
  const until = Number(rec && rec.until) || 0;
  const why = String((rec && rec.reason) || "").slice(0, 200);
  if (until > 0) {
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
    return "บัญชีนี้ถูกระงับชั่วคราว — เหลืออีก " + mins + " นาที" + (why ? " (" + why + ")" : "");
  }
  return "บัญชีนี้ถูกระงับการใช้งาน" + (why ? " (" + why + ")" : "") + " — ติดต่อผู้ดูแลเพื่อขอปลด";
}

/**
 * @param days 0 หรือไม่ใส่ = ถาวร
 * @param by   "auto" หรือชื่อบัญชีผู้ดูแลที่สั่งแบน
 */
export async function ban(user, { by = "auto", reason = "", days = 0 } = {}) {
  const u = String(user || "").trim();
  if (!u) return { ok: false, msg: "ไม่ได้ระบุบัญชี" };
  const d = Math.max(0, Number(days) || 0);
  const rec = {
    user: u, at: Date.now(), by: String(by).slice(0, 32),
    reason: String(reason || "").slice(0, 200),
    until: d > 0 ? Date.now() + d * 86_400_000 : 0,
  };
  await store.set(KEY(u), JSON.stringify(rec));
  // v79.3: จำค่าแฮช IP ที่บัญชีนี้สมัครไว้ชั่วคราว -> บัญชีใหม่จาก IP เดิมเริ่มในสถานะจำกัด
  //        (แค่หน่วง — รีเราเตอร์ก็ได้ IP ใหม่ จึงไม่เอาไปแบนอัตโนมัติ)
  const acct = parse(await store.get("sof:acct:" + u.toLowerCase()));
  if (acct && acct.rip) await store.setex("sof:banip:" + acct.rip, BANIP_TTL, "1");
  // token ที่ยังค้างอยู่ใช้ต่อไม่ได้อยู่แล้ว เพราะ /api/save ตรวจ banInfo ทุกครั้ง
  return { ok: true, ban: rec };
}

export async function unban(user) {
  const u = String(user || "").trim();
  if (!u) return { ok: false, msg: "ไม่ได้ระบุบัญชี" };
  const had = await store.get(KEY(u));
  await store.del(KEY(u));
  // v79.3: ปลดแบน = ปลดสถานะจำกัดและเลิกจำ IP นั้นด้วย (ถือว่าเป็นการเข้าใจผิด)
  const ak = "sof:acct:" + u.toLowerCase();
  const acct = parse(await store.get(ak));
  if (acct) {
    if (acct.rip) await store.del("sof:banip:" + acct.rip);
    if (acct.restricted) { delete acct.restricted; await store.set(ak, JSON.stringify(acct)); }
  }
  return { ok: true, user: u, was_banned: !!had };
}

/** ปลดเฉพาะ "สถานะจำกัด" (เล่นได้อยู่แล้ว แค่ยังเทรดไม่ได้) */
export async function unrestrict(user) {
  const u = String(user || "").trim();
  if (!u) return { ok: false, msg: "ไม่ได้ระบุบัญชี" };
  const ak = "sof:acct:" + u.toLowerCase();
  const acct = parse(await store.get(ak));
  if (!acct) return { ok: false, msg: "ไม่พบบัญชีนี้" };
  const was = !!acct.restricted;
  if (was) { delete acct.restricted; await store.set(ak, JSON.stringify(acct)); }
  if (acct.rip) await store.del("sof:banip:" + acct.rip);
  return { ok: true, user: u, was_restricted: was };
}

/** รายชื่อบัญชีที่ถูกแบนอยู่ (หน้า /admin) */
export async function listBans() {
  const keys = await store.scanPrefix(KEY(""));
  const rows = (await store.mgetBatched(keys, 100)).map(parse);
  const now = Date.now();
  return rows
    .filter((r) => r && (!Number(r.until) || Number(r.until) > now))
    .map((r) => ({ user: r.user, at: Number(r.at) || 0, by: r.by || "?", reason: r.reason || "",
      until: Number(r.until) || 0 }))
    .sort((a, b) => b.at - a.at);
}

/**
 * ธงถึงเพดานแล้วแบนให้เอง -> คืน record ถ้าแบน, null ถ้ายังไม่ถึง/ปิดไว้/เป็นบัญชียกเว้น
 * @param strikes จำนวนธงสะสมของบัญชีนี้
 */
export async function maybeAutoBan(user, strikes, exempt = false) {
  if (!autoBanOn() || exempt) return null;
  if (Number(strikes) < autoBanFlags()) return null;
  if (await banInfo(user)) return null;                 // ถูกแบนอยู่แล้ว
  const r = await ban(user, { by: "auto", reason: AUTO_REASON + " (" + strikes + " ครั้ง)" });
  return r.ok ? r.ban : null;
}
