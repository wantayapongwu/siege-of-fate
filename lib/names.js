// lib/names.js -- v58: ทะเบียนชื่อตัวละคร "ห้ามซ้ำทั้งเซิร์ฟเวอร์"
//
// ทำไมต้องไม่ซ้ำ: ในเกมใช้ "ชื่อตัวละคร" อ้างถึงกันตรงๆ (กระซิบ / ชวนปาร์ตี้ / เทรด / คลังกิลล์)
// ถ้ามีสองคนชื่อเดียวกัน ข้อความจะไปผิดคน
//
// คีย์: sof:cname:<ชื่อตัวพิมพ์เล็ก> -> ชื่อบัญชีเจ้าของ (ถาวร ไม่มีวันหมดอายุ)
//   claim : จองชื่อ (บัญชีเดิมจองชื่อเดิมซ้ำได้ = ไม่ error)
//   check : ถามว่าชื่อนี้ว่างไหม
//   free  : คืนชื่อ (ตอนลบตัวละคร)
import * as store from "./store.js";
import { userOf } from "./accounts.js";

export const NAME_MIN = 2;
export const NAME_MAX = 14;
// ไทย / อังกฤษ / ตัวเลข เท่านั้น (ตรงกับกฎในตัวเกม)
const NAME_RE = /^[฀-๿a-zA-Z0-9]{2,14}$/;

export function validName(n) {
  return NAME_RE.test(String(n || ""));
}
const key = (n) => "sof:cname:" + String(n).toLowerCase();

/** เจ้าของชื่อนี้ (บัญชีไหน) | "" = ยังว่าง */
export async function ownerOf(name) {
  return String((await store.get(key(name))) || "");
}

/** จองชื่อให้บัญชี user -> {ok, owner} */
export async function claim(name, user) {
  if (!validName(name)) return { ok: false, msg: "ชื่อไม่ถูกต้อง" };
  const u = String(user).toLowerCase();
  if (await store.setnx(key(name), u)) return { ok: true, owner: u };
  const owner = await ownerOf(name);
  if (owner === u) return { ok: true, owner };               // ชื่อของเราเอง
  return { ok: false, owner, msg: "มีผู้เล่นคนอื่นใช้ชื่อนี้แล้ว" };
}

/** คืนชื่อ (เฉพาะเจ้าของเท่านั้น) */
export async function free(name, user) {
  const owner = await ownerOf(name);
  if (owner && owner !== String(user).toLowerCase()) return false;
  await store.del(key(name));
  return true;
}

export async function handleName(method, body, headers = {}) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const action = String(body.action || "");
  const name = String(body.name || "").trim();
  if (action === "check") {
    if (!validName(name)) return [200, { ok: false, free: false, msg: "ชื่อไม่ถูกต้อง" }];
    const owner = await ownerOf(name);
    const me = String((await userOf(String(body.token || ""))) || "").toLowerCase();
    return [200, { ok: true, free: owner === "" || (me !== "" && owner === me), owner_is_me: me !== "" && owner === me }];
  }
  const user = await userOf(String(body.token || ""));
  if (!user) return [401, { ok: false, msg: "ต้องล็อกอินก่อน" }];
  if (action === "claim") {
    const r = await claim(name, user);
    return [r.ok ? 200 : 409, { ok: r.ok, msg: r.msg || "", owner_is_me: r.ok }];
  }
  if (action === "free") {
    return [200, { ok: await free(name, user) }];
  }
  return [400, { ok: false, msg: "action?" }];
}
