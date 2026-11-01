// lib/gate.js -- v79.3: ด่านเวลา/เลเวลก่อนแตะ "ของที่แชร์กับคนอื่น"
//
// ที่มา: สมัครฟรีไม่ระบุตัวตน -> ถูกแบนแล้วสมัคร id ใหม่ได้ทันที การแบนจึงแค่ "เพิ่มต้นทุน"
//        ทางที่ได้ผลกว่าคือทำให้ id ใหม่เอี่ยม "ทำร้ายคนอื่นไม่ได้"
//        เพราะความเสียหายจริงไม่ได้อยู่ที่เลเวล/เงินของตัวเอง (เซฟถูกปฏิเสธอยู่แล้ว)
//        แต่อยู่ที่การยัดของ/เงินเข้าไปในคลังกิลด์ การเทรด และตลาดประมูล
//
// ด่านนี้ใช้กับ: คลังกิลด์ (/api/gstash) + เทรดข้ามบัญชี + ตลาดประมูล
// ไม่ใช้กับ: การเล่นปกติ เซฟ เลเวล ของในกระเป๋าตัวเอง (บัญชีใหม่เล่นได้เต็มที่)
//
// เงื่อนไข (ปรับได้ด้วย env ไม่ต้องแก้โค้ด):
//   SOF_TRADE_MIN_HOURS  อายุบัญชีขั้นต่ำ (ชั่วโมง)   ค่าเริ่มต้น 5
//   SOF_TRADE_MIN_LEVEL  เลเวลสูงสุดในบัญชีขั้นต่ำ     ค่าเริ่มต้น 20
//   ธง hard ค้างใน 24 ชม. -> ยังแตะไม่ได้ (รอให้ผู้ดูแลดูก่อน)
//   บัญชีที่สมัครจาก IP ซึ่งเพิ่งมีคนถูกแบน -> ตั้งสถานะจำกัด (เล่นได้ แต่ยังแตะเศรษฐกิจไม่ได้)
import * as store from "./store.js";
import { lastProgress, flagKey } from "./anticheat.js";
import { banInfo } from "./bans.js";

export const STRIKE_HOLD_MS = 24 * 3_600_000;

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

export function minHours() {
  const n = Number(process.env.SOF_TRADE_MIN_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

export function minLevel() {
  const n = Number(process.env.SOF_TRADE_MIN_LEVEL);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
}

/**
 * บัญชีนี้แตะระบบที่แชร์กับคนอื่นได้ไหม
 * @returns {ok, reason, hours, need_hours, level, need_level, restricted, strikes}
 */
export async function tradeGate(user, nowMs = Date.now()) {
  const u = String(user || "").toLowerCase();
  const needH = minHours();
  const needL = minLevel();
  const out = { ok: false, reason: "", hours: 0, need_hours: needH, level: 0, need_level: needL,
    restricted: false, strikes: 0 };
  if (!u) { out.reason = "ต้องล็อกอินก่อน"; return out; }

  const bn = await banInfo(user);
  if (bn) { out.reason = "บัญชีนี้ถูกระงับ"; return out; }

  const acct = parse(await store.get("sof:acct:" + u));
  if (!acct) { out.reason = "ไม่พบบัญชี"; return out; }
  out.hours = Math.max(0, (nowMs - (Number(acct.created) || 0)) / 3_600_000);
  out.restricted = !!acct.restricted;

  // ความก้าวหน้าที่เซิร์ฟเวอร์รับไว้แล้ว (ไม่ใช่ตัวเลขที่ไคลเอนต์เพิ่งส่งมา)
  const prog = await lastProgress(user);
  out.level = prog ? Number(prog.level) || 0 : 0;

  const fl = parse(await store.get(flagKey(user)));
  out.strikes = fl ? Number(fl.strikes || 0) : 0;
  const strikeAt = fl ? Number(fl.strike_at || 0) : 0;

  if (out.restricted) {
    out.reason = "บัญชีนี้อยู่ในสถานะจำกัด — เล่นได้ปกติ แต่ยังเทรด/ใช้คลังกิลด์ไม่ได้ ติดต่อผู้ดูแลเพื่อขอปลด";
    return out;
  }
  if (out.hours < needH) {
    const left = Math.max(1, Math.ceil(needH - out.hours));
    out.reason = `บัญชีใหม่ต้องมีอายุครบ ${needH} ชั่วโมงก่อนเทรด/ใช้คลังกิลด์ (เหลืออีกราว ${left} ชั่วโมง)`;
    return out;
  }
  if (out.level < needL) {
    out.reason = `ต้องมีตัวละครถึงเลเวล ${needL} ก่อนเทรด/ใช้คลังกิลด์ (ตอนนี้ ${out.level})`;
    return out;
  }
  if (out.strikes > 0 && nowMs - strikeAt < STRIKE_HOLD_MS) {
    out.reason = "บัญชีนี้มีเซฟที่ถูกปฏิเสธเมื่อเร็วๆ นี้ — รอ 24 ชั่วโมงหรือติดต่อผู้ดูแล";
    return out;
  }
  out.ok = true;
  return out;
}
