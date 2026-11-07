// lib/lobby.js -- ตรรกะล็อบบี้ (แยกจาก HTTP เพื่อทดสอบได้)
import crypto from "node:crypto";
import * as store from "./store.js";

export const ROOM_TTL = 90;
export const STALE_MS = 45000;          // วินาที — Host ต้องส่ง heartbeat ภายในเวลานี้ (เกมส่งทุก 30 วิ)
export const MAX_ROOMS_PER_IP = 3;
export const MAX_ROOMS_PER_ACCOUNT = 2;   // v79.4

// v79.4: เปิดห้องต้องล็อกอินก่อน
// ที่มา: เดิมใครก็ยิง register ได้โดยไม่ต้องมีบัญชี -> สแปมรายชื่อห้องได้ฟรี (จำกัดแค่ต่อ IP ซึ่งหมุนได้)
// ตอนนี้ต้องส่ง token บัญชี (ฟิลด์ acct) มาด้วย และจำกัดจำนวนห้องต่อบัญชี
// ปิดด่านนี้ได้ด้วย SOF_ROOMS_REQUIRE_LOGIN=0 (เผื่อเซิร์ฟเวอร์เฉพาะ/LAN ที่ไม่มีบัญชี)
export function roomsRequireLogin() {
  return String(process.env.SOF_ROOMS_REQUIRE_LOGIN || "") !== "0";
}
export const RATE_PER_MIN = 40;
const SET = "sof:rooms";

const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const validHost = (h) => /^[0-9a-fA-F:.]{3,45}$/.test(h) || /^[a-zA-Z0-9.-]{3,253}$/.test(h);

// v80.7: เดิมหยิบค่า "ซ้ายสุด" ของ x-forwarded-for ซึ่งเป็นค่าที่ไคลเอนต์แทรกเองได้
//   -> ส่งเฮดเดอร์ปลอมเพื่อหนี rate limit / หนีแบน หรือใส่ IP ของเหยื่อให้โดนแบนแทนได้
//   เอกสาร Vercel: "Vercel overwrites this header and does not forward external IPs to prevent IP spoofing"
//   แต่จะเชื่อ x-forwarded-for ได้ก็ต่อเมื่อไม่มีพร็อกซีอื่นวางทับ Vercel อยู่
//   ลำดับที่เชื่อถือได้ (จากมากไปน้อย):
//     1) x-vercel-forwarded-for  Vercel เติมให้เสมอ และลบของที่ไคลเอนต์ส่งมาทิ้ง
//     2) x-real-ip               Vercel เติมให้เช่นกัน
//     3) x-forwarded-for         เอา "ขวาสุด" = ค่าที่พร็อกซีชั้นที่ใกล้เราที่สุดเติม
//                                (ซ้ายสุดคือค่าที่ไคลเอนต์แทรกเองได้)
//   ตั้ง SOF_TRUST_XFF_LEFT=1 ได้ถ้าโฮสต์ที่ใช้การันตีว่าเขียนทับทั้งเฮดเดอร์จริง
const firstIp = (v) => String(v || "").split(",")[0].trim();
const lastIp = (v) => {
  const parts = String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
};

export function clientIp(headers) {
  const h = headers || {};
  const trustLeft = String(process.env.SOF_TRUST_XFF_LEFT || "") === "1";
  const ip = firstIp(h["x-vercel-forwarded-for"])
    || String(h["x-real-ip"] || "").trim()
    || (trustLeft ? firstIp(h["x-forwarded-for"]) : lastIp(h["x-forwarded-for"]))
    || "";
  return ip.replace(/^::ffff:/, "");
}

/** v79.4: ห้องที่ยังไม่หมดอายุของบัญชีนี้ (อ่านจากระเบียนดิบ ไม่ส่งชื่อบัญชีออกไปในรายชื่อห้องสาธารณะ) */
export async function roomsOwnedBy(owner) {
  const o = String(owner || "");
  if (!o) return [];
  const ids = await store.smembers(SET);
  const vals = await store.mget(ids.map((i) => "sof:room:" + i));
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const v = vals[i];
    if (!v) continue;
    const r = typeof v === "string" ? JSON.parse(v) : v;
    if (String(r.owner || "") === o && Date.now() - (r.updated || 0) <= STALE_MS) out.push(r);
  }
  return out;
}

async function limited(ip) {
  return (await store.hit("sof:rate:" + ip, 60)) > RATE_PER_MIN;
}

// v80.75: รับเฉพาะ ws:// / wss:// ที่ชี้ไปโฮสต์ที่หน้าตาถูกต้อง (กันคนลงทะเบียนที่อยู่มั่วๆ)
export function validWsUrl(u) {
  const s = String(u || "").trim();
  if (!/^wss?:\/\//i.test(s) || s.length > 253) return "";
  let parsed;
  try { parsed = new URL(s); } catch { return ""; }
  if (parsed.search || parsed.hash) return "";
  if (!validHost(parsed.hostname.replace(/^\[|\]$/g, ""))) return "";
  if (parsed.port && !(Number(parsed.port) >= 1 && Number(parsed.port) <= 65535)) return "";
  return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname);
}

export async function listRooms(proto, transport = "") {
  const ids = await store.smembers(SET);
  const vals = await store.mget(ids.map((i) => "sof:room:" + i));
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const v = vals[i];
    if (!v) { await store.srem(SET, ids[i]); continue; }
    const r = typeof v === "string" ? JSON.parse(v) : v;
    if (proto && r.proto !== proto) continue;
    if (Date.now() - (r.updated || 0) > STALE_MS) continue;   // v28.3: ไม่ส่ง heartbeat เกิน 45 วิ = ถือว่าปิดแล้ว
    if (transport && (r.transport || "enet") !== transport) continue;
    // v78.4 ข้อมูลรั่ว: เดิมส่ง "ไอพีจริงของผู้เล่นที่เปิดห้อง" ให้ทุกคนที่ยิง GET /api/rooms
    //                  ห้องแบบ WebRTC (เวอร์ชันเว็บ) ต่อผ่านตัวกลางอยู่แล้ว ไม่เคยต้องใช้ไอพี -> ไม่ส่งออกอีก
    //                  ห้องแบบ ENet (เวอร์ชันพีซี ต่อหากันตรงๆ) ยังต้องใช้ไอพีถึงจะต่อได้ตามธรรมชาติของ P2P
    const kind = r.transport || "enet";
    // v80.75: ห้อง ws ต่อด้วย url ไม่ใช่ไอพีดิบ -> ไม่ต้องส่งไอพีออกไปเหมือนห้อง WebRTC
    const hideIp = kind === "webrtc" || kind === "ws";
    out.push({ id: r.id, name: r.name, host: r.host, ip: hideIp ? "" : r.ip, port: kind === "webrtc" ? 0 : r.port,
      url: kind === "ws" ? (r.url || "") : "",
      players: r.players, max: r.max, proto: r.proto, dedicated: !!r.dedicated,
      transport: kind, channel: r.channel || 1, updated: r.updated });
  }
  out.sort((a, b) => b.players - a.players || b.updated - a.updated);
  return out;
}

// v37: ตั้ง TURN ของตัวเองได้ด้วย env SOF_ICE_SERVERS (JSON array แบบ RTCIceServer) — ไม่ตั้ง = เกมใช้ค่าเริ่มต้น (STUN + Open Relay)
export function iceServers() {
  try {
    const v = JSON.parse(process.env.SOF_ICE_SERVERS || "[]");
    return Array.isArray(v) ? v.filter((s) => s && s.urls) : [];
  } catch { return []; }
}

export async function handle(method, body, headers, query) {
  const ip = clientIp(headers);
  if (method === "GET") {
    const rooms = await listRooms(clean(query.proto, 24), clean(query.transport, 8));
    return [200, { ok: true, rooms, storage: store.storageKind(), your_ip: ip, ice: iceServers() }];
  }
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  if (!ip) return [400, { ok: false, msg: "no ip" }];
  if (await limited(ip)) return [429, { ok: false, msg: "ส่งคำขอถี่เกินไป ลองใหม่ภายหลัง" }];
  const b = body && typeof body === "object" ? body : {};
  const action = clean(b.action, 16);
  if (action === "register") {
    const proto = clean(b.proto, 24);
    // v79.4: ต้องเป็นบัญชีที่ล็อกอินอยู่ และบัญชีที่ถูกระงับเปิดห้องไม่ได้
    let owner = "";
    if (roomsRequireLogin()) {
      const { userOf } = await import("./accounts.js");
      const { banInfo, banMessage } = await import("./bans.js");
      owner = (await userOf(clean(b.acct, 64))) || "";
      if (!owner) return [401, { ok: false, msg: "ต้องล็อกอินก่อนจึงจะเปิดห้องให้คนอื่นเห็นได้" }];
      const bn = await banInfo(owner);
      if (bn) return [403, { ok: false, msg: banMessage(bn), banned: true }];
      const mineAcct = await roomsOwnedBy(owner);
      if (mineAcct.length >= MAX_ROOMS_PER_ACCOUNT)
        return [429, { ok: false, msg: "บัญชีนี้เปิดห้องค้างอยู่ " + mineAcct.length + " ห้องแล้ว" }];
    }
    if (!proto.startsWith("sof-")) return [400, { ok: false, msg: "เวอร์ชันเกมไม่ถูกต้อง" }];
    // v80.75: เพิ่ม transport "ws" — เซิร์ฟเวอร์ WebSocket ที่เบราว์เซอร์ต่อตรงได้ (ไม่ต้องมีผู้เล่นเป็นโฮสต์)
    const transport = b.transport === "webrtc" ? "webrtc" : (b.transport === "ws" ? "ws" : "enet");
    const port = transport === "webrtc" ? 0 : Number(b.port) | 0;
    if (transport !== "webrtc" && (port < 1 || port > 65535)) return [400, { ok: false, msg: "พอร์ตไม่ถูกต้อง" }];
    // ห้องแบบ ws ต้องบอก "ที่อยู่ที่เบราว์เซอร์จะต่อ" มาด้วย (หน้าเว็บเป็น https จึงต้องเป็น wss://)
    const wsUrl = transport === "ws" ? validWsUrl(clean(b.url, 253)) : "";
    if (transport === "ws" && !wsUrl)
      return [400, { ok: false, msg: "ที่อยู่ WebSocket ไม่ถูกต้อง (ต้องขึ้นต้นด้วย ws:// หรือ wss://)" }];
    const mine = (await listRooms("")).filter((r) => r.ip === ip);
    if (mine.length >= MAX_ROOMS_PER_IP) return [429, { ok: false, msg: "สร้างห้องจาก IP นี้ได้สูงสุด " + MAX_ROOMS_PER_IP + " ห้อง" }];
    // เซิร์ฟเวอร์เฉพาะระบุที่อยู่สาธารณะเองได้ (โดเมน/IP) — ไม่ระบุ = ใช้ IP ที่ส่งคำขอมา
    const pub = clean(b.public_host, 253);
    const room = {
      id: crypto.randomBytes(6).toString("hex"),
      token: crypto.randomBytes(16).toString("hex"),
      name: clean(b.name, 32) || "ห้องของ " + (clean(b.host, 16) || "ผู้เล่น"),
      host: clean(b.host, 16) || "?",
      ip: pub && validHost(pub) ? pub : ip,
      port,
      players: Math.max(0, Math.min(999, Number(b.players) | 0)),
      max: Math.max(1, Math.min(999, Number(b.max) | 0 || 32)),
      proto,
      dedicated: !!b.dedicated,
      transport,
      url: wsUrl,
      channel: Math.max(1, Math.min(2, Number(b.channel) | 0 || 1)),   // v32: แชแนล 1-2
      owner,                                                           // v79.4: บัญชีที่เปิดห้อง (ไม่ส่งออกให้ผู้เล่นทั่วไป)
      updated: Date.now(),
    };
    await store.setex("sof:room:" + room.id, ROOM_TTL, JSON.stringify(room));
    await store.sadd(SET, room.id);
    return [200, { ok: true, id: room.id, token: room.token, ip: room.ip, ttl: ROOM_TTL }];
  }
  // v80.78: เซิร์ฟเวอร์เกมแจ้งทะเบียน uid ของที่ตัวเองทอย (พิสูจน์ตัวด้วย token ของห้องที่ลงทะเบียนไว้)
  //   ต้องเป็นห้องแบบ dedicated เท่านั้น — ห้องที่ผู้เล่นเปิดเองจดทะเบียนให้ตัวเองไม่ได้
  if (action === "loot") {
    const id = clean(b.id, 24);
    const raw = await store.get("sof:room:" + id);
    if (!raw) return [404, { ok: false, msg: "ไม่พบห้อง (หมดเวลา) — ลงทะเบียนใหม่" }];
    const room = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (room.token !== clean(b.token, 64)) return [403, { ok: false, msg: "token ไม่ถูกต้อง" }];
    if (!room.dedicated) return [403, { ok: false, msg: "ห้องของผู้เล่นจดทะเบียนของไม่ได้" }];
    const uids = Array.isArray(b.uids) ? b.uids.slice(0, 500) : [];
    const { markLootMinted } = await import("./anticheat.js");
    const n = await markLootMinted(uids);
    return [200, { ok: true, noted: n }];
  }
  if (action === "heartbeat" || action === "remove") {
    const id = clean(b.id, 24);
    const raw = await store.get("sof:room:" + id);
    if (!raw) return [404, { ok: false, msg: "ไม่พบห้อง (หมดเวลา) — ลงทะเบียนใหม่" }];
    const room = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (room.token !== clean(b.token, 64)) return [403, { ok: false, msg: "token ไม่ถูกต้อง" }];
    if (action === "remove") {
      await store.del("sof:room:" + id);
      await store.srem(SET, id);
      return [200, { ok: true }];
    }
    room.players = Math.max(0, Math.min(999, Number(b.players) | 0));
    room.updated = Date.now();
    await store.setex("sof:room:" + id, ROOM_TTL, JSON.stringify(room));
    return [200, { ok: true, ttl: ROOM_TTL }];
  }
  return [400, { ok: false, msg: "action?" }];
}
