// lib/lobby.js -- ตรรกะล็อบบี้ (แยกจาก HTTP เพื่อทดสอบได้)
import crypto from "node:crypto";
import * as store from "./store.js";

export const ROOM_TTL = 90;
export const STALE_MS = 45000;          // วินาที — Host ต้องส่ง heartbeat ภายในเวลานี้ (เกมส่งทุก 30 วิ)
export const MAX_ROOMS_PER_IP = 3;
export const RATE_PER_MIN = 40;
const SET = "sof:rooms";

const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const validHost = (h) => /^[0-9a-fA-F:.]{3,45}$/.test(h) || /^[a-zA-Z0-9.-]{3,253}$/.test(h);

export function clientIp(headers) {
  const xf = String(headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xf || String(headers["x-real-ip"] || "").trim() || "";
  return ip.replace(/^::ffff:/, "");
}

async function limited(ip) {
  return (await store.hit("sof:rate:" + ip, 60)) > RATE_PER_MIN;
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
    out.push({ id: r.id, name: r.name, host: r.host, ip: r.ip, port: r.port, players: r.players, max: r.max, proto: r.proto, dedicated: !!r.dedicated, transport: r.transport || "enet", channel: r.channel || 1, updated: r.updated });
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
    if (!proto.startsWith("sof-")) return [400, { ok: false, msg: "เวอร์ชันเกมไม่ถูกต้อง" }];
    const transport = b.transport === "webrtc" ? "webrtc" : "enet";
    const port = transport === "webrtc" ? 0 : Number(b.port) | 0;
    if (transport === "enet" && (port < 1 || port > 65535)) return [400, { ok: false, msg: "พอร์ตไม่ถูกต้อง" }];
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
      channel: Math.max(1, Math.min(2, Number(b.channel) | 0 || 1)),   // v32: แชแนล 1-2
      updated: Date.now(),
    };
    await store.setex("sof:room:" + room.id, ROOM_TTL, JSON.stringify(room));
    await store.sadd(SET, room.id);
    return [200, { ok: true, id: room.id, token: room.token, ip: room.ip, ttl: ROOM_TTL }];
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
