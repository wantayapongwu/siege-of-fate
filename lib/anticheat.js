// lib/anticheat.js -- v78.4: ตรวจ "ความเป็นไปได้" ของเซฟก่อนรับเข้าเซิร์ฟเวอร์
//
// ที่มา: เกมนี้คิดทุกอย่างในเครื่องผู้เล่น (client-authoritative) แล้วส่ง "ก้อนเซฟ" ขึ้นมาเก็บ
//        เดิมเซิร์ฟเวอร์รับทุกอย่างที่ส่งมาโดยไม่ตรวจเลย -> ใครก็ได้ที่สมัครบัญชี (ฟรี เปิดให้ทุกคน)
//        ยิง POST /api/save ด้วยเซฟที่เขียนเองได้ เช่น เลเวล 100 + เงินล้าน โดยไม่ต้อง "เจาะ" อะไรเลย
//
// ไฟล์นี้ไม่ได้ทำให้โกงไม่ได้ 100% (ต้องย้ายการคำนวณไปอยู่บนเซิร์ฟเวอร์ถึงจะปิดสนิท)
// แต่ปิดช่องที่ใช้ง่ายที่สุด และทำให้การโกงที่เหลือ "ช้าลงจนไม่คุ้ม" + ตรวจจับได้:
//   1) เพดานตายตัว  — เลเวลเกิน 100 / เงินติดลบ / เงินเกินเพดาน = ปฏิเสธทันที
//   2) อัตราความก้าวหน้า — เทียบกับเซฟก่อนหน้าของบัญชีเดียวกัน เลเวลและเงินโตเร็วเกินจริงไม่ได้
//   3) บันทึกธง — ครั้งที่ถูกปฏิเสธถูกเก็บไว้ให้หน้า /admin เห็น (ใครพยายามโกงบ้าง)
//
// ค่าปรับได้ด้วย env (ไม่ต้องแก้โค้ด): SOF_MAX_LEVEL_PER_HOUR, SOF_MAX_GOLD_PER_HOUR, SOF_GOLD_CAP
import * as store from "./store.js";

export const MAX_LEVEL = 100;
export const FREE_LEVEL = 20;          // เลเวลต้นเกมขึ้นเร็วมากโดยตั้งใจ -> ไม่คิดอัตราในช่วงนี้

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0);

export function limits() {
  return {
    levelPerHour: Math.max(1, num(process.env.SOF_MAX_LEVEL_PER_HOUR) || 12),
    goldPerHour: Math.max(1000, num(process.env.SOF_MAX_GOLD_PER_HOUR) || 300_000),
    goldCap: Math.max(1_000_000, num(process.env.SOF_GOLD_CAP) || 1_000_000_000),
  };
}

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

/** ตัวละครทั้งหมดในก้อนเซฟ (ไฟล์ characters_*.json) */
export function charsOfSave(save) {
  const out = [];
  if (!save || !save.files || typeof save.files !== "object") return out;
  for (const [name, text] of Object.entries(save.files)) {
    if (!name.startsWith("characters_")) continue;
    const list = parse(text);
    if (Array.isArray(list)) for (const c of list) if (c && typeof c === "object" && c.name) out.push(c);
  }
  return out;
}

/** สรุปความก้าวหน้าของบัญชี: เลเวลสูงสุด + เงินรวม + เลเวลรายตัวละคร */
export function progressOf(save) {
  const chars = charsOfSave(save);
  const per = {};
  let maxLevel = 0, gold = 0;
  for (const c of chars) {
    const lv = num(c.level) || 1;
    const g = num((c.inventory || {}).gold);
    const key = String(c.name);
    per[key] = { level: lv, gold: g };
    if (lv > maxLevel) maxLevel = lv;
    gold += g;
  }
  return { chars: chars.length, max_level: maxLevel, gold, per };
}

/** ค่าที่เป็นไปไม่ได้เลย ไม่ว่าจะเล่นมานานแค่ไหน */
function hardFaults(prog, lim) {
  const bad = [];
  for (const [name, p] of Object.entries(prog.per)) {
    if (!Number.isInteger(p.level) || p.level < 1 || p.level > MAX_LEVEL)
      bad.push(`${name}: เลเวล ${p.level} (ต้องเป็น 1-${MAX_LEVEL})`);
    if (!Number.isFinite(p.gold) || p.gold < 0 || p.gold > lim.goldCap)
      bad.push(`${name}: เงิน ${p.gold} (ต้องเป็น 0-${lim.goldCap})`);
  }
  if (prog.chars > 40) bad.push(`ตัวละคร ${prog.chars} ตัว (มากผิดปกติ)`);
  return bad;
}

/**
 * ความก้าวหน้าโตเร็วเกินจริงไหม เทียบกับเซฟที่รับไว้ก่อนหน้า
 * @param prev {level, gold, t} สถานะที่รับไว้ครั้งก่อน (null = ครั้งแรก)
 */
function rateFaults(prog, prev, nowMs, lim) {
  const bad = [];
  if (!prev) return bad;                       // ครั้งแรกของบัญชี -> มีแต่เพดานตายตัว
  const hours = Math.max(0, (nowMs - num(prev.t)) / 3_600_000);
  // ผ่อนให้ช่วงต้นเกม (ถึงเลเวล FREE_LEVEL ขึ้นเร็วมากโดยตั้งใจ) + เผื่อ 1 ชม. แรกเสมอ
  const allowLevel = FREE_LEVEL + Math.ceil((hours + 1) * lim.levelPerHour);
  const allowGold = lim.goldPerHour * (hours + 1);
  if (prog.max_level > num(prev.level) && prog.max_level > allowLevel)
    bad.push(`เลเวลพุ่งจาก ${num(prev.level)} เป็น ${prog.max_level} ในเวลา ${hours.toFixed(2)} ชม. (เพดาน ${allowLevel})`);
  const gained = prog.gold - num(prev.gold);
  if (gained > allowGold)
    bad.push(`เงินเพิ่ม ${Math.round(gained).toLocaleString()} ในเวลา ${hours.toFixed(2)} ชม. (เพดาน ${Math.round(allowGold).toLocaleString()})`);
  return bad;
}

const progKey = (user) => "sof:prog:" + String(user).toLowerCase();
export const flagKey = (user) => "sof:cheatflag:" + String(user).toLowerCase();

/** สถานะความก้าวหน้าที่รับไว้ครั้งก่อน */
export async function lastProgress(user) {
  return parse(await store.get(progKey(user)));
}

/** จำสถานะล่าสุดที่รับเข้าไว้ (ใช้เทียบครั้งถัดไป) */
export async function rememberProgress(user, prog, nowMs) {
  await store.set(progKey(user), JSON.stringify({ level: prog.max_level, gold: prog.gold, t: nowMs }));
}

/** บันทึกธงว่าบัญชีนี้ส่งเซฟที่เป็นไปไม่ได้ (หน้า /admin อ่านได้) */
export async function flag(user, reasons, nowMs) {
  const cur = parse(await store.get(flagKey(user))) || { n: 0, first: nowMs, items: [] };
  cur.n += 1;
  cur.last = nowMs;
  cur.items = [...(cur.items || []), { t: nowMs, reasons }].slice(-20);
  await store.set(flagKey(user), JSON.stringify(cur));
  return cur.n;
}

/**
 * ตรวจเซฟก่อนรับ -> {ok:true, prog} หรือ {ok:false, reasons:[...]}
 * บัญชีที่อยู่ใน SOF_ANTICHEAT_EXEMPT (คั่นด้วย ,) ข้ามการตรวจอัตรา (ไว้ให้บัญชีทดสอบของผู้พัฒนา)
 */
export async function checkSave(user, save, nowMs = Date.now()) {
  const lim = limits();
  const prog = progressOf(save);
  const reasons = hardFaults(prog, lim);
  const exempt = String(process.env.SOF_ANTICHEAT_EXEMPT || "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)
    .includes(String(user).toLowerCase());
  if (!exempt) reasons.push(...rateFaults(prog, await lastProgress(user), nowMs, lim));
  if (reasons.length) return { ok: false, reasons, prog };
  return { ok: true, prog };
}
