// lib/store.js -- ที่เก็บรายชื่อห้อง
//  • มี Upstash Redis (เพิ่มจาก Vercel Marketplace -> ได้ env KV_REST_API_URL / KV_REST_API_TOKEN
//    หรือ UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) = เก็บถาวร ทุกเครื่องเห็นตรงกัน
//  • ไม่มี = เก็บในหน่วยความจำ (ใช้ทดสอบเท่านั้น: บน Vercel แต่ละ instance ไม่แชร์กัน ห้องอาจหาย/ไม่ครบ)

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export function storageKind() {
  return URL && TOKEN ? "redis" : "memory";
}

// ---------- Redis (Upstash REST) ----------
async function redis(cmds) {
  const r = await fetch(URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const out = await r.json();
  return out.map((x) => (x && "result" in x ? x.result : null));
}

// ---------- หน่วยความจำ ----------
const mem = globalThis.__sofLobbyMem || (globalThis.__sofLobbyMem = { kv: new Map(), set: new Set() });
function memGet(k) {
  const e = mem.kv.get(k);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.kv.delete(k); return null; }
  return e.v;
}

export async function setex(key, sec, value) {
  if (storageKind() === "redis") { await redis([["SET", key, value, "EX", String(sec)]]); return; }
  mem.kv.set(key, { v: value, exp: Date.now() + sec * 1000 });
}
export async function get(key) {
  if (storageKind() === "redis") return (await redis([["GET", key]]))[0];
  return memGet(key);
}
export async function mget(keys) {
  if (!keys.length) return [];
  if (storageKind() === "redis") return (await redis([["MGET", ...keys]]))[0] || [];
  return keys.map(memGet);
}
export async function del(key) {
  if (storageKind() === "redis") { await redis([["DEL", key]]); return; }
  mem.kv.delete(key);
}
export async function sadd(set, member) {
  if (storageKind() === "redis") { await redis([["SADD", set, member]]); return; }
  mem.set.add(set + "\u0000" + member);
}
export async function srem(set, member) {
  if (storageKind() === "redis") { await redis([["SREM", set, member]]); return; }
  mem.set.delete(set + "\u0000" + member);
}
export async function smembers(set) {
  if (storageKind() === "redis") return (await redis([["SMEMBERS", set]]))[0] || [];
  const p = set + "\u0000";
  return [...mem.set].filter((x) => x.startsWith(p)).map((x) => x.slice(p.length));
}
// นับคำขอต่อช่วงเวลา (กันสแปม): คืนจำนวนครั้งในหน้าต่างนี้
export async function hit(key, windowSec) {
  if (storageKind() === "redis") {
    const [n] = await redis([["INCR", key], ["EXPIRE", key, String(windowSec), "NX"]]);
    return Number(n) || 0;
  }
  const n = (Number(memGet(key)) || 0) + 1;
  const e = mem.kv.get(key);
  mem.kv.set(key, { v: n, exp: e && e.exp > Date.now() ? e.exp : Date.now() + windowSec * 1000 });
  return n;
}
export function _resetMemory() { mem.kv.clear(); mem.set.clear(); }
