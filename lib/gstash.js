// lib/gstash.js -- คลังกิลล์ร่วมกันบนเซิร์ฟเวอร์ (v38): สมาชิกกิลล์ทุกคนเห็นคลังเดียวกัน (เดิมเก็บแยกในเครื่องใครเครื่องมัน)
// POST {action:"get",  token, gid}                         -> {ok, rev, slots, log}
// POST {action:"put",  token, gid, who, idx, item}          -> {ok, rev, slots} | 409 ช่องไม่ว่าง (ส่งสถานะล่าสุดกลับ)
// POST {action:"take", token, gid, who, idx, uid}           -> {ok, rev, slots, item} | 409 ของชิ้นนี้ถูกถอนไปแล้ว
// gid = รหัสกิลล์ (ชื่อ + หัวหน้าผู้ก่อตั้ง + เวลาก่อตั้ง) | ทุกการเปลี่ยนแปลงล็อกคลังไว้ชั่วครู่ -> ฝาก/ถอนพร้อมกันไม่ทำให้ของซ้ำ
import * as store from "./store.js";
import { userOf } from "./accounts.js";

export const SIZE = 144;
const GID_RE = /^[^\u0000-\u001f]{3,120}$/;
const MAX_ITEM = 20000;
const LOG_MAX = 60;

function blank() { return { rev: 0, slots: Array.from({ length: SIZE }, () => null), log: [] }; }
async function load(key) {
  const raw = await store.get(key);
  if (!raw) return blank();
  const d = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(d.slots) || d.slots.length !== SIZE) d.slots = blank().slots;
  d.log = Array.isArray(d.log) ? d.log : [];
  d.rev = Number(d.rev) || 0;
  return d;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function handleGStash(method, body) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const b = body && typeof body === "object" ? body : {};
  const user = await userOf(String(b.token || ""));
  if (!user) return [401, { ok: false, msg: "หมดเวลาเข้าสู่ระบบ — ล็อกอินใหม่" }];
  const gid = String(b.gid || "");
  if (!GID_RE.test(gid)) return [400, { ok: false, msg: "gid?" }];
  const key = "sof:gstash:" + gid;
  const action = String(b.action || "");
  if (action === "get") {
    const d = await load(key);
    return [200, { ok: true, rev: d.rev, slots: d.slots, log: d.log.slice(-20) }];
  }
  if (action !== "put" && action !== "take") return [400, { ok: false, msg: "action?" }];
  if ((await store.hit("sof:gsrate:" + user.toLowerCase(), 10)) > 40) return [429, { ok: false, msg: "ถี่เกินไป" }];
  const idx = Number(b.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= SIZE) return [400, { ok: false, msg: "idx?" }];
  const who = String(b.who || user).slice(0, 40);
  const lk = key + ":lock";
  let got = false;
  for (let i = 0; i < 25 && !got; i++) { got = await store.lock(lk, 5); if (!got) await sleep(80); }
  if (!got) return [503, { ok: false, msg: "คลังกิลล์ไม่ว่าง ลองใหม่" }];
  try {
    const d = await load(key);
    if (action === "put") {
      const item = b.item && typeof b.item === "object" ? b.item : null;
      if (!item || JSON.stringify(item).length > MAX_ITEM) return [400, { ok: false, msg: "item?" }];
      if (d.slots[idx]) return [409, { ok: false, msg: "ช่องนี้มีของแล้ว", rev: d.rev, slots: d.slots }];
      if (item.uid && d.slots.some((s) => s && s.uid === item.uid)) return [409, { ok: false, msg: "ของชิ้นนี้อยู่ในคลังแล้ว", rev: d.rev, slots: d.slots }];
      d.slots[idx] = item;
      d.rev += 1;
      d.log.push(`[r${d.rev}] ${who}: ฝาก ${String(item.name || "?").slice(0, 60)}`);
    } else {
      const cur = d.slots[idx];
      if (!cur || (b.uid && cur.uid !== b.uid)) return [409, { ok: false, msg: "ของชิ้นนี้ถูกถอนไปแล้ว", rev: d.rev, slots: d.slots }];
      d.slots[idx] = null;
      d.rev += 1;
      d.log.push(`[r${d.rev}] ${who}: ถอน ${String(cur.name || "?").slice(0, 60)}`);
      d.log = d.log.slice(-LOG_MAX);
      await store.set(key, JSON.stringify(d));
      return [200, { ok: true, rev: d.rev, slots: d.slots, item: cur }];
    }
    d.log = d.log.slice(-LOG_MAX);
    await store.set(key, JSON.stringify(d));
    return [200, { ok: true, rev: d.rev, slots: d.slots }];
  } finally {
    await store.del(lk);
  }
}
