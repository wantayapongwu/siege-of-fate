// lib/maintenance.js -- v57: งานบำรุงรักษาประจำวัน (ตี 3 ตามเวลาไทย)
// ฝั่งล็อบบี้เป็น Serverless จึงไม่มี "เครื่อง" ให้รีสตาร์ท แต่ของที่ค้างสะสมคือ "ข้อมูลขยะ" ใน Redis
// งานนี้จึงเป็นการ "เคลียร์แรม" ของฝั่งเว็บ: กวาดของค้างทิ้งให้หมด ก่อนเริ่มวันใหม่
//   • ห้องที่เงียบ/หมดอายุ แต่ยังค้างอยู่ในดัชนีรายชื่อห้อง
//   • กล่องจดหมายสัญญาณ WebRTC ของห้องที่ไม่มีแล้ว
//   • ประวัติการโดนระงับ (strike) ที่หมดอายุแล้ว
import * as store from "./store.js";
import { STALE_MS } from "./lobby.js";

const SET = "sof:rooms";

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
  return out;
}

/** คำขอนี้เป็นของ Vercel Cron จริงไหม (หรือผู้ดูแลที่ถือ CRON_SECRET) */
export function cronAuthorized(headers = {}, query = {}) {
  const secret = String(process.env.CRON_SECRET || "");
  const auth = String(headers["authorization"] || "");
  if (secret && auth === "Bearer " + secret) return true;
  if (secret && String(query.key || "") === secret) return true;
  if (!secret && String(headers["x-vercel-cron"] || "") !== "") return true;   // ยังไม่ตั้ง CRON_SECRET = เชื่อเฉพาะที่ Vercel ยิงเอง
  return false;
}
