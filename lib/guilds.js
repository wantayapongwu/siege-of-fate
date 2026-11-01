// lib/guilds.js -- v78.5: ทะเบียนสมาชิกกิลด์ฝั่งเซิร์ฟเวอร์
//
// ที่มา: คลังกิลด์เคยตรวจแค่ "ส่ง gid ถูกไหม" ซึ่งไม่ใช่ความลับจริง
//        gid = "<ชื่อกิลด์>|<เวลาก่อตั้งเป็นวินาที>" -> รู้ชื่อกิลด์ (เห็นในเกม) + เดาเวลาในช่วงหนึ่งวัน
//        = เดาได้ราว 86,400 ครั้ง ซึ่งสคริปต์ทำได้สบาย แล้วเปิดดู/ถอนของในคลังกิลด์คนอื่นได้เลย
// ตอนนี้: เซิร์ฟเวอร์เก็บทะเบียนเอง ทุกคำสั่งของคลังกิลด์ต้องเป็น "สมาชิกที่อยู่ในทะเบียน" เท่านั้น
//
// ทะเบียนมาจากไหน (ระบบกิลด์ของเกมอยู่ฝั่งผู้เล่น เซิร์ฟเวอร์ไม่เคยรู้มาก่อน):
//   - ครั้งแรกที่มีคนเรียก gid นี้ -> ตั้งคนนั้นเป็นเจ้าของทะเบียน และรับรายชื่อจากเครื่องเขาเป็นชุดตั้งต้น
//   - หลังจากนั้น "เฉพาะคนที่อยู่ในทะเบียนแล้ว" เท่านั้นที่แก้รายชื่อได้ และรายชื่อใหม่ต้องมีตัวเขาเองอยู่ด้วย
//   - ชื่อตัวละคร -> บัญชี แปลงด้วยทะเบียนชื่อตัวละครที่ไม่ซ้ำทั้งเซิร์ฟเวอร์ (lib/names.js)
// ผลคือคนนอกกิลด์เข้าไม่ได้แม้จะเดา gid ถูก และคนในกิลด์ไม่ต้องทำอะไรเพิ่ม
import * as store from "./store.js";
import { ownerOf } from "./names.js";
import { charsOfSave } from "./anticheat.js";

export const MAX_MEMBERS = 30;          // ตรงกับ Guild.MAX_MEMBERS ในตัวเกม
// v79.5: ตั้งทะเบียนครั้งแรกต้องเคยอยู่ในกิลด์ชื่อนี้มาแล้วอย่างน้อยเท่านี้
// ที่มา: c.guild ในเซฟเป็นค่าที่ไคลเอนต์เขียนเอง (ด่านกันโกงไม่เคยตรวจช่องนี้)
//        -> เสกเซฟที่บอกว่า "อยู่กิลด์ TargetGuild" แล้วแย่งตั้งทะเบียนได้ทันที
//        ตอนนี้ต้องรอ: เวลาที่เริ่มเห็นชื่อกิลด์นี้ในเซฟถูกจดด้วยเวลาของเซิร์ฟเวอร์ (ปลอมไม่ได้)
//        สมาชิกจริงที่อยู่กิลด์มาเป็นวันผ่านทันที คนเสกเซฟต้องรอหนึ่งวันต่อหนึ่งครั้งที่ลอง
export const CLAIM_MIN_HOURS = 24;
export const claimKey = (user, gname) =>
  "sof:gclaim:" + String(user).toLowerCase() + "|" + String(gname).trim().toLowerCase();

/** จดไว้ว่าเห็นบัญชีนี้อยู่ในกิลด์ชื่อนี้ครั้งแรกเมื่อไหร่ (เรียกตอนรับเซฟ) */
export async function noteGuildClaim(user, gname, nowMs = Date.now()) {
  const g = String(gname || "").trim();
  if (!g) return;
  await store.setnx(claimKey(user, g), String(nowMs));
}

/** เห็นบัญชีนี้อยู่ในกิลด์ชื่อนี้มากี่ชั่วโมงแล้ว (0 = ไม่เคยเห็น) */
export async function claimAgeHours(user, gname, nowMs = Date.now()) {
  const t = Number(await store.get(claimKey(user, gname))) || 0;
  return t > 0 ? Math.max(0, (nowMs - t) / 3_600_000) : 0;
}
const KEY = (gid) => "sof:guild:" + gid;

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

export async function load(gid) {
  return parse(await store.get(KEY(gid)));
}

/** ชื่อกิลด์ที่อยู่ในรหัสกิลด์ (gid = "<ชื่อกิลด์>|<เวลาก่อตั้ง>") */
export function guildNameOf(gid) {
  return String(gid || "").split("|")[0].trim();
}

/**
 * v79.4: ตัวละครของบัญชีนี้ "อยู่ในกิลด์ชื่อนี้จริง" ตามเซฟที่เซิร์ฟเวอร์รับไว้แล้วไหม
 *
 * ที่มาของรู: เดิมใครเรียก gid นี้คนแรกได้เป็นเจ้าของทะเบียนเลย
 *   gid เดาได้ (ชื่อกิลด์เห็นในเกม + เวลาก่อตั้งอยู่ในช่วงวันเดียว ~86,400 ครั้ง)
 *   -> แย่งตั้งทะเบียนก่อนที่สมาชิกจริงจะเปิดคลังครั้งแรก แล้วถอนของที่สมาชิกจริงฝากเข้าไปได้
 * ตอนนี้: ต้องมีเซฟที่ผ่านด่านแล้ว และในเซฟมีตัวละครที่อยู่ในกิลด์ชื่อนั้น
 *   เซฟปลอมผ่านด่านไม่ได้ (v78.8-v79.2) จึงปลอมความเป็นสมาชิกไม่ได้
 */
export async function provesMembership(user, gid) {
  const want = guildNameOf(gid).toLowerCase();
  if (!want) return false;
  const raw = await store.get("sof:save:" + String(user).toLowerCase());
  const save = parse(raw);
  if (!save) return false;
  for (const c of charsOfSave(save)) {
    const g = c.guild;
    const nm = g && typeof g === "object" ? g.name : g;
    if (String(nm || "").trim().toLowerCase() === want) return true;
  }
  return false;
}

export function isMember(reg, user) {
  if (!reg || !reg.members) return false;
  return !!reg.members[String(user).toLowerCase()];
}

/** แปลงรายชื่อตัวละคร -> ชุดบัญชีเจ้าของ (ชื่อที่ไม่มีเจ้าของถูกข้าม) */
async function accountsOf(names) {
  const out = {};
  const list = Array.isArray(names) ? names.slice(0, MAX_MEMBERS * 2) : [];
  for (const n of list) {
    const nm = String(n || "").slice(0, 32);
    if (!nm) continue;
    const owner = await ownerOf(nm);
    if (owner) out[String(owner).toLowerCase()] = nm;
  }
  return out;
}

/**
 * ตรวจสิทธิ์ + อัปเดตทะเบียนในคำสั่งเดียว
 * @param gid    รหัสกิลด์
 * @param user   บัญชีที่ล็อกอินอยู่ (มาจาก token แล้ว เชื่อถือได้)
 * @param chr    ชื่อตัวละครที่ไคลเอนต์บอก (ใช้แค่แสดงผล)
 * @param roster รายชื่อสมาชิกจากเครื่องผู้เล่น (ถ้ามี) -> ใช้ตั้งทะเบียนครั้งแรก / อัปเดตโดยสมาชิก
 * @returns {ok:true, reg} | {ok:false, code, msg}
 */
export async function authorize(gid, user, chr, roster) {
  const u = String(user).toLowerCase();
  let reg = await load(gid);

  if (!reg) {
    // ครั้งแรกของ gid นี้ -> คนที่เรียกตั้งทะเบียนให้ แต่ต้องพิสูจน์ก่อนว่าอยู่ในกิลด์ชื่อนี้จริง
    // (v79.4: เดิมเชื่อคนที่เรียกคนแรก -> เดา gid ถูกแล้วแย่งตั้งทะเบียนกิลด์คนอื่นได้)
    if (!(await provesMembership(u, gid)))
      return { ok: false, code: 403, msg: "ต้องเข้าเกมด้วยตัวละครที่อยู่ในกิลด์นี้และบันทึกขึ้นเซิร์ฟเวอร์ก่อนหนึ่งครั้ง" };
    // v79.5: และต้องอยู่ในกิลด์ชื่อนี้มาแล้วพอสมควร (เวลามาจากเซิร์ฟเวอร์ ปลอมไม่ได้)
    const age = await claimAgeHours(u, guildNameOf(gid));
    if (age < CLAIM_MIN_HOURS)
      return { ok: false, code: 403,
        msg: `คลังกิลด์นี้ยังไม่ถูกตั้งค่า — ต้องอยู่ในกิลด์นี้ครบ ${CLAIM_MIN_HOURS} ชั่วโมงก่อน (ตอนนี้ ${age.toFixed(1)} ชั่วโมง)` };
    const members = await accountsOf(roster);
    members[u] = String(chr || user).slice(0, 32);
    reg = { gid, owner: u, members, created: Date.now(), updated: Date.now() };
    await store.set(KEY(gid), JSON.stringify(reg));
    return { ok: true, reg, created: true };
  }

  if (!isMember(reg, u)) return { ok: false, code: 403, msg: "ไม่ได้อยู่ในกิลด์นี้" };

  // v79.5: เดิมสมาชิก "คนไหนก็ได้" ส่งรายชื่อมาแทนที่ทะเบียนทั้งชุดได้
  //        -> ลูกกิลด์คนเดียวส่ง roster ที่มีแต่ชื่อตัวเอง = ถีบทุกคนออกจากคลังกิลด์
  //        ตอนนี้: เจ้าของทะเบียนแทนที่ได้ทั้งชุด | สมาชิกทั่วไปทำได้แค่ "เพิ่มชื่อ" ไม่ลบใคร
  if (Array.isArray(roster) && roster.length) {
    const next = await accountsOf(roster);
    next[u] = String(chr || user).slice(0, 32);
    let members;
    if (u === String(reg.owner).toLowerCase()) {
      members = {};
      for (const k of Object.keys(next).slice(0, MAX_MEMBERS)) members[k] = next[k];
      if (!members[reg.owner] && reg.members[reg.owner]) members[reg.owner] = reg.members[reg.owner];
    } else {
      members = Object.assign({}, reg.members);
      for (const k of Object.keys(next)) {
        if (Object.keys(members).length >= MAX_MEMBERS) break;
        if (!members[k]) members[k] = next[k];
      }
    }
    const changed = JSON.stringify(Object.keys(members).sort()) !== JSON.stringify(Object.keys(reg.members).sort());
    if (changed) {
      reg.members = members;
      reg.updated = Date.now();
      await store.set(KEY(gid), JSON.stringify(reg));
    }
  }
  return { ok: true, reg };
}

/** รายชื่อสมาชิก (สำหรับหน้า /admin) */
export async function membersOf(gid) {
  const reg = await load(gid);
  return reg ? Object.entries(reg.members || {}).map(([acct, name]) => ({ account: acct, character: name })) : [];
}
