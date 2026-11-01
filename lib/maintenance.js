// lib/maintenance.js -- v57: งานบำรุงรักษาประจำวัน (ตี 3 ตามเวลาไทย)
// ฝั่งล็อบบี้เป็น Serverless จึงไม่มี "เครื่อง" ให้รีสตาร์ท แต่ของที่ค้างสะสมคือ "ข้อมูลขยะ" ใน Redis
// งานนี้จึงเป็นการ "เคลียร์แรม" ของฝั่งเว็บ: กวาดของค้างทิ้งให้หมด ก่อนเริ่มวันใหม่
//   • ห้องที่เงียบ/หมดอายุ แต่ยังค้างอยู่ในดัชนีรายชื่อห้อง
//   • กล่องจดหมายสัญญาณ WebRTC ของห้องที่ไม่มีแล้ว
//   • ประวัติการโดนระงับ (strike) ที่หมดอายุแล้ว
import * as store from "./store.js";
import { STALE_MS } from "./lobby.js";

const SET = "sof:rooms";
// v80.7: คลังกิลด์ที่ว่างเปล่าและไม่มีความเคลื่อนไหวนานเท่านี้ = ถือว่าถูกทิ้ง
export const EMPTY_GSTASH_MS = 14 * 24 * 3_600_000;   // 14 วัน

export async function cleanup(nowMs = Date.now()) {
  const out = { rooms_checked: 0, rooms_dropped: 0, signal_dropped: 0, bans_cleared: 0, at: new Date(nowMs).toISOString() };
  // 1) ห้องค้าง
  const ids = await store.smembers(SET);
  out.rooms_checked = ids.length;
  const vals = await store.mget(ids.map((i) => "sof:room:" + i));
  const alive = new Set();
  for (let i = 0; i < ids.length; i++) {
    const v = vals[i];
    if (!v) { await store.srem(SET, ids[i]); out.rooms_dropped++; continue; }
    const r = typeof v === "string" ? JSON.parse(v) : v;
    if (nowMs - (r.updated || 0) > STALE_MS * 4) {      // เงียบเกิน 3 นาที = ปิดไปแล้วแน่ๆ
      await store.del("sof:room:" + ids[i]);
      await store.srem(SET, ids[i]);
      out.rooms_dropped++;
      continue;
    }
    alive.add(String(r.id));
  }
  // 2) กล่องจดหมายสัญญาณของห้องที่ไม่มีแล้ว
  for (const k of await store.scanPrefix("sof:sig:", 5000)) {
    const room = k.split(":")[2] || "";
    if (!alive.has(room)) { await store.del(k); out.signal_dropped++; }
  }
  // 3) ประวัติการระงับที่หมดอายุ (ค่าที่เก็บคือเวลาสิ้นสุด)
  for (const k of await store.scanPrefix("sof:ban:", 5000)) {
    const v = await store.get(k);
    if (!v || Number(v) < nowMs) { await store.del(k); out.bans_cleared++; }
  }
  // 4) v80.7: คลังกิลด์ที่ "ว่างเปล่าและไม่มีใครแตะมานาน" — บอตปั๊มบัญชีแล้วสร้าง gid เปล่าทิ้งไว้
  //    ถมพื้นที่เก็บได้ไม่จำกัด (economic DoS) -> กวาดทิ้งพร้อมทะเบียนกิลด์ของมัน
  out.gstash_dropped = 0;
  for (const k of await store.scanPrefix("sof:gstash:", 5000)) {
    const v = await store.get(k);
    const d = v ? (typeof v === "string" ? JSON.parse(v) : v) : null;
    if (!d) { await store.del(k); out.gstash_dropped++; continue; }
    const empty = !Array.isArray(d.slots) || d.slots.every((x) => !x);
    const idle = nowMs - Number(d.updated || d.created || 0) > EMPTY_GSTASH_MS;
    if (empty && idle) {
      await store.del(k);
      await store.del("sof:guild:" + k.slice("sof:gstash:".length));
      out.gstash_dropped++;
    }
  }
  return out;
}

/** คำขอนี้เป็นของ Vercel Cron จริงไหม (หรือผู้ดูแลที่ถือ CRON_SECRET) */
export function cronAuthorized(headers = {}, query = {}) {
  const secret = String(process.env.CRON_SECRET || "");
  const auth = String(headers["authorization"] || "");
  if (secret && auth === "Bearer " + secret) return true;
  if (secret && String(query.key || "") === secret) return true;
  // v79.5: เดิม "ไม่ตั้ง CRON_SECRET = เชื่อ header x-vercel-cron" — แต่ header นั้นใครก็ใส่มาได้
  //        งานล้างข้อมูลยิง Redis หลักหมื่นคำสั่งต่อครั้ง -> กลายเป็นช่องถล่มเซิร์ฟเวอร์
  //        ตอนนี้ไม่ตั้งคีย์ = ปิดงานนี้ไปเลย (ตั้ง CRON_SECRET ใน Vercel แล้วใส่ใน vercel.json)
  return false;
}
