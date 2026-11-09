// lib/signal.js -- ส่งต่อสัญญาณ WebRTC (offer / answer / ICE) ระหว่างผู้เล่นบนเว็บ (v28.2)
// ข้อความเก็บเป็นกล่องจดหมายต่อห้อง+ผู้รับ อายุ 2 นาที | ผู้เล่นถามหาข้อความ (poll) ทุก ~0.5 วิ ระหว่างเชื่อมต่อเท่านั้น
//
// ======================== v78.5: ปิดช่อง "ปลอมเป็นเจ้าของห้อง" ========================
// เดิมกล่องจดหมายอ้างอิงแค่ชื่อ และเจ้าของห้องใช้ชื่อคงที่ว่า "host" โดยไม่มีความลับอะไรเลย
// ใครที่รู้รหัสห้อง (ซึ่งเปิดเผยอยู่ใน /api/rooms) จึงทำได้สองอย่าง:
//   1) poll ในชื่อ "host" = ดูดสัญญาณของเจ้าของห้องไปทั้งหมด -> ห้องพัง ไม่มีใครต่อติด
//   2) ส่งข้อความโดยอ้างว่า from = "host" -> ผู้เข้าห้องเชื่อ (โค้ดฝั่งเกมรับเฉพาะ from == "host")
//      แล้วเข้าไปนั่งกลางทางระหว่างสองฝ่ายได้
// ตอนนี้ทุกกล่องต้อง "จอง" ก่อนใช้ แล้วได้กุญแจประจำรอบ (sig key) มา ทุกครั้งที่ส่ง/ถามต้องแนบกุญแจ
//   - กล่อง "host" จองได้เฉพาะคนที่มี token ของห้อง (ซึ่งมีแต่เจ้าของห้องที่เพิ่งลงทะเบียน)
//   - กล่องของผู้เข้าห้อง: ใครจองก่อนได้ก่อน ชนกันก็แค่สุ่มชื่อใหม่
import crypto from "node:crypto";
import * as store from "./store.js";
import { clientIp } from "./lobby.js";
import { userOf } from "./accounts.js";

const TTL = 120;
const KEY_TTL = 900;             // กุญแจประจำรอบอยู่ได้ 15 นาที (ต่ออายุได้ด้วยการจองซ้ำ)
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KEY_RE = /^[a-f0-9]{32}$/;

const keyName = (room, me) => "sof:sigkey:" + room + ":" + me;

/** กุญแจที่แนบมาตรงกับกล่องนี้ไหม */
async function keyOk(room, me, given) {
  if (!KEY_RE.test(String(given || ""))) return false;
  const want = await store.get(keyName(room, me));
  if (!want) return false;
  const a = Buffer.from(String(given), "utf8");
  const b = Buffer.from(String(want), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function roomOf(id) {
  const raw = await store.get("sof:room:" + id);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function handleSignal(method, body, headers) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const ip = clientIp(headers) || "?";
  const b = body && typeof body === "object" ? body : {};
  const room = String(b.room || ""), me = String(b.me || "");
  if (!ID_RE.test(room) || !ID_RE.test(me)) return [400, { ok: false, msg: "room/me" }];

  // ---------- จองกล่องจดหมาย -> ได้กุญแจประจำรอบ ----------
  if (b.action === "claim") {
    if ((await store.hit("sof:sigclaim:" + ip, 60)) > 30) return [429, { ok: false, msg: "จองกล่องถี่เกินไป" }];
    const r = await roomOf(room);
    if (!r) return [404, { ok: false, msg: "ไม่พบห้อง (หมดเวลา)" }];
    const mine = await store.get(keyName(room, me));
    if (me === "host") {
      // กล่องของเจ้าของห้อง: ต้องมี token ของห้องเท่านั้น (คนอื่นจองแทนไม่ได้)
      if (String(b.room_token || "") !== String(r.token || "")) return [403, { ok: false, msg: "ไม่ใช่เจ้าของห้อง" }];
    } else if (mine && String(b.key || "") !== String(mine)) {
      // ชื่อนี้มีคนใช้อยู่แล้ว -> ให้ฝั่งเกมสุ่มชื่อใหม่
      return [409, { ok: false, msg: "ชื่อนี้ถูกใช้แล้ว" }];
    }
    const key = String(mine || crypto.randomBytes(16).toString("hex"));
    await store.setex(keyName(room, me), KEY_TTL, key);
    // ถ้าแนบ token บัญชีมาด้วย เก็บไว้ดูย้อนหลังว่าใครอยู่ห้องไหน (ไม่บังคับ ไม่ได้ใช้ตัดสินสิทธิ์)
    const who = b.token ? await userOf(String(b.token)) : null;
    if (who) await store.setex("sof:sigwho:" + room + ":" + me, KEY_TTL, who);
    return [200, { ok: true, key, ttl: KEY_TTL }];
  }

  if (b.action === "send") {
    // นับ/ตรวจห้องเฉพาะตอนส่ง (poll ถี่ -> ใช้ 1 คำสั่ง Redis ต่อครั้ง)
    if ((await store.hit("sof:srate:" + ip, 60)) > 300) return [429, { ok: false, msg: "ส่งสัญญาณถี่เกินไป" }];
    if (!(await store.get("sof:room:" + room))) return [404, { ok: false, msg: "ห้องปิดแล้ว" }];
    if (!(await keyOk(room, me, b.key))) return [403, { ok: false, msg: "ต้องจองกล่องจดหมายก่อน", need_claim: true }];
    const to = String(b.to || "");
    if (!ID_RE.test(to)) return [400, { ok: false, msg: "to" }];
    const data = JSON.stringify({ from: me, msg: b.msg ?? null });
    if (data.length > 16000) return [413, { ok: false, msg: "ข้อความใหญ่เกินไป" }];
    await store.rpushex("sof:sig:" + room + ":" + to, TTL, data);
    return [200, { ok: true }];
  }

  if (b.action === "poll") {
    if (!(await keyOk(room, me, b.key))) return [403, { ok: false, msg: "ต้องจองกล่องจดหมายก่อน", need_claim: true }];
    const raw = await store.drain("sof:sig:" + room + ":" + me);
    return [200, { ok: true, msgs: raw.map((x) => (typeof x === "string" ? JSON.parse(x) : x)) }];
  }
  return [400, { ok: false, msg: "action?" }];
}
