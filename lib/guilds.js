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

export const MAX_MEMBERS = 30;          // ตรงกับ Guild.MAX_MEMBERS ในตัวเกม
const KEY = (gid) => "sof:guild:" + gid;

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

export async function load(gid) {
  return parse(await store.get(KEY(gid)));
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
    // ครั้งแรกของ gid นี้ -> คนที่เรียกคนแรกตั้งทะเบียนให้ (เป็นสมาชิกจริงของกิลด์อยู่แล้วจึงจะมี gid)
    const members = await accountsOf(roster);
    members[u] = String(chr || user).slice(0, 32);
    reg = { gid, owner: u, members, created: Date.now(), updated: Date.now() };
    await store.set(KEY(gid), JSON.stringify(reg));
    return { ok: true, reg, created: true };
  }

  if (!isMember(reg, u)) return { ok: false, code: 403, msg: "ไม่ได้อยู่ในกิลด์นี้" };

  // สมาชิกส่งรายชื่อล่าสุดมาด้วย -> อัปเดตทะเบียน (ต้องมีตัวผู้ส่งอยู่ในรายชื่อเสมอ กันถีบตัวเองทิ้ง)
  if (Array.isArray(roster) && roster.length) {
    const next = await accountsOf(roster);
    next[u] = String(chr || user).slice(0, 32);
    const keys = Object.keys(next).slice(0, MAX_MEMBERS);
    const members = {};
    for (const k of keys) members[k] = next[k];
    if (!members[reg.owner] && reg.members[reg.owner]) members[reg.owner] = reg.members[reg.owner];
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
