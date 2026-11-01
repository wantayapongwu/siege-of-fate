// lib/dungeon.js -- v79.0: นับ "จำนวนครั้งที่รีเซ็ตดันเจี้ยน" ไว้ที่เซิร์ฟเวอร์
//
// ทำไมต้องนับที่เซิร์ฟเวอร์:
//   สถิติอื่นในเกมนี้ (เลเวล/เงิน/บอสที่ล้ม) ถูกคิดในเครื่องผู้เล่นแล้วอัปขึ้นมาเป็น "ก้อนเซฟ"
//   = ตัวเลขเหล่านั้นแก้ได้ ถ้าคนตั้งใจแก้ไฟล์เซฟหรือยิง /api/save เอง
//   ตัวเลขที่เซิร์ฟเวอร์ "เห็นเหตุการณ์เอง" (ตอนที่เกมยิงมาบอกว่ารีดันแล้ว) เชื่อถือได้มากกว่า
//   เพราะเวลาและการนับเกิดขึ้นที่นี่ ปลอมย้อนหลังไม่ได้
//
// สิ่งที่ยังทำได้ (พูดตามตรง):
//   - "ไม่ยิงมา" ได้ -> ตัวเลขฝั่งเซิร์ฟเวอร์ต่ำกว่าความจริง (เล่นออฟไลน์ก็เข้ากรณีนี้)
//   - "ยิงรัว" ได้ -> จึงมีช่องว่างขั้นต่ำต่อครั้ง + เพดานต่อวัน และไม่เอาตัวเลขนี้ไปเป็นโควตากันโกง
//     (ถ้าเอาไปเป็นโควตา คนยิงรัวจะได้โควตา EXP ฟรี)
//   ปิดสนิทได้ทางเดียวคือย้ายการสร้างดันเจี้ยนขึ้นมาอยู่บนเซิร์ฟเวอร์ ซึ่งเป็นงานใหญ่กว่านี้มาก
//
// ปาร์ตี้: เวลาโหวตรีเซ็ตผ่าน ทุกคนในปาร์ตี้ถูกรีพร้อมกัน -> แต่ละเครื่องยิงของตัวเองมา
//          ดังนั้นสมาชิก 4 คนรีหนึ่งครั้ง = นับ 1 ครั้งต่อคน ซึ่งตรงกับที่เกิดขึ้นจริงกับทุกคน
import * as store from "./store.js";
import { userOf } from "./accounts.js";

export const MIN_GAP_MS = 2_500;     // รีถี่กว่านี้ไม่นับ (รีดันจริงต้องโหลดแผนที่ใหม่ เร็วกว่านี้ไม่ได้)
export const DAY_CAP = 2_000;        // นับได้ไม่เกินวันละเท่านี้ต่อบัญชี (ฟาร์มหนักสุดยังไม่ถึง)
export const MAX_MAPS = 24;          // จำชื่อด่านไว้ไม่เกินนี้ต่อบัญชี

const KEY = (u) => "sof:dgr:" + String(u).toLowerCase();
const DAYKEY = (u) => "sof:dgrday:" + String(u).toLowerCase();

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

export async function load(user) {
  return parse(await store.get(KEY(user)));
}

/** บันทึกว่าบัญชีนี้รีดันหนึ่งครั้ง -> {counted, n} */
export async function noteReset(user, map = "", level = 0, nowMs = Date.now()) {
  const k = KEY(user);
  const cur = parse(await store.get(k)) || { n: 0, first: nowMs, last: 0, skipped: 0, maps: {} };

  // ยิงรัวเกินกว่าที่รีจริงได้ -> ไม่นับ แต่จดไว้ว่าถูกเมิน (หน้า /admin เห็นว่าใครยิงรัว)
  if (nowMs - Number(cur.last || 0) < MIN_GAP_MS) {
    cur.skipped = Number(cur.skipped || 0) + 1;
    await store.set(k, JSON.stringify(cur));
    return { ok: true, counted: false, n: cur.n, reason: "เร็วเกินไป" };
  }
  const today = await store.hit(DAYKEY(user), 86_400);
  if (today > DAY_CAP) {
    cur.skipped = Number(cur.skipped || 0) + 1;
    await store.set(k, JSON.stringify(cur));
    return { ok: true, counted: false, n: cur.n, reason: "เกินเพดานต่อวัน" };
  }

  cur.n = Number(cur.n || 0) + 1;
  cur.last = nowMs;
  const m = String(map || "").slice(0, 32);
  if (m) {
    cur.maps = cur.maps && typeof cur.maps === "object" ? cur.maps : {};
    if (cur.maps[m] != null || Object.keys(cur.maps).length < MAX_MAPS)
      cur.maps[m] = Number(cur.maps[m] || 0) + 1;
  }
  if (Number(level) > 0) cur.last_level = Number(level);
  await store.set(k, JSON.stringify(cur));
  return { ok: true, counted: true, n: cur.n, today };
}

/** สรุปทุกบัญชีสำหรับหน้า /admin */
export async function statsAll() {
  const keys = await store.scanPrefix(KEY(""));
  const rows = (await store.mgetBatched(keys, 100)).map(parse);
  const per = {};
  const maps = {};
  let total = 0, players = 0, skipped = 0;
  for (let i = 0; i < keys.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const u = keys[i].slice(KEY("").length);
    const n = Number(r.n || 0);
    per[u] = { resets: n, first: Number(r.first || 0), last: Number(r.last || 0), skipped: Number(r.skipped || 0) };
    total += n;
    skipped += Number(r.skipped || 0);
    if (n > 0) players++;
    for (const [m, c] of Object.entries(r.maps || {})) maps[m] = Number(maps[m] || 0) + Number(c || 0);
  }
  const top_maps = Object.entries(maps)
    .map(([map, resets]) => ({ map, resets }))
    .sort((a, b) => b.resets - a.resets);
  return { total, players, skipped, per, top_maps };
}

export async function handleDungeon(method, body) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const b = body && typeof body === "object" ? body : {};
  const user = await userOf(b.token);
  if (!user) return [401, { ok: false, msg: "ต้องล็อกอินก่อน" }];
  if (String(b.action || "") !== "reset") return [400, { ok: false, msg: "action?" }];
  return [200, await noteReset(user, b.map, b.level)];
}
