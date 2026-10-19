// lib/signal.js -- ส่งต่อสัญญาณ WebRTC (offer / answer / ICE) ระหว่างผู้เล่นบนเว็บ (v28.2)
// ข้อความเก็บเป็นกล่องจดหมายต่อห้อง+ผู้รับ อายุ 2 นาที | ผู้เล่นถามหาข้อความ (poll) ทุก ~0.5 วิ ระหว่างเชื่อมต่อเท่านั้น
import * as store from "./store.js";
import { clientIp } from "./lobby.js";

const TTL = 120;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export async function handleSignal(method, body, headers) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const ip = clientIp(headers) || "?";
  const b = body && typeof body === "object" ? body : {};
  const room = String(b.room || ""), me = String(b.me || "");
  if (!ID_RE.test(room) || !ID_RE.test(me)) return [400, { ok: false, msg: "room/me" }];
  if (b.action === "send") {
    // นับ/ตรวจห้องเฉพาะตอนส่ง (poll ถี่ -> ใช้ 1 คำสั่ง Redis ต่อครั้ง)
    if ((await store.hit("sof:srate:" + ip, 60)) > 300) return [429, { ok: false, msg: "ส่งสัญญาณถี่เกินไป" }];
    if (!(await store.get("sof:room:" + room))) return [404, { ok: false, msg: "ห้องปิดแล้ว" }];
    const to = String(b.to || "");
    if (!ID_RE.test(to)) return [400, { ok: false, msg: "to" }];
    const data = JSON.stringify({ from: me, msg: b.msg ?? null });
    if (data.length > 16000) return [413, { ok: false, msg: "ข้อความใหญ่เกินไป" }];
    await store.rpushex("sof:sig:" + room + ":" + to, TTL, data);
    return [200, { ok: true }];
  }
  if (b.action === "poll") {
    const raw = await store.drain("sof:sig:" + room + ":" + me);
    return [200, { ok: true, msgs: raw.map((x) => (typeof x === "string" ? JSON.parse(x) : x)) }];
  }
  return [400, { ok: false, msg: "action?" }];
}
