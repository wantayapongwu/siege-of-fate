// lib/accounts.js -- บัญชีผู้เล่นบนเซิร์ฟเวอร์ (v28.2): สมัคร / ล็อกอิน / ตรวจ token
// รหัสผ่านเก็บแบบ scrypt + salt สุ่ม (ไม่เก็บรหัสจริง) | token สุ่ม อายุ 30 วัน
import crypto from "node:crypto";
import * as store from "./store.js";
import { clientIp } from "./lobby.js";

const TOKEN_TTL = 30 * 24 * 3600;
const USER_RE = /^[A-Za-z0-9]{3,16}$/;
export const DEV_ID = "l3ladeEmperRor";
// v35: ผู้ดูแลที่เปิดหน้า /admin ได้ = บัญชีผู้พัฒนา + รายชื่อเพิ่มใน env SOF_ADMIN_USERS (คั่นด้วย ,)
export function isAdmin(user) {
  if (!user) return false;
  const extra = String(process.env.SOF_ADMIN_USERS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const u = String(user).toLowerCase();
  return u === DEV_ID.toLowerCase() || extra.includes(u);
}

function hashPw(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString("hex");
}
async function issue(user) {
  const token = crypto.randomBytes(24).toString("hex");
  await store.setex("sof:tok:" + token, TOKEN_TTL, user);
  return token;
}
export async function userOf(token) {
  if (!token || typeof token !== "string" || token.length > 64) return null;
  return await store.get("sof:tok:" + token);
}

export async function handleAuth(method, body, headers) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const ip = clientIp(headers) || "?";
  if ((await store.hit("sof:arate:" + ip, 60)) > 20) return [429, { ok: false, msg: "ลองบ่อยเกินไป รอสักครู่" }];
  const b = body && typeof body === "object" ? body : {};
  const action = String(b.action || "");
  if (action === "me") {
    const u = await userOf(String(b.token || ""));
    return u ? [200, { ok: true, user: u, dev: u === DEV_ID, admin: isAdmin(u) }] : [401, { ok: false, msg: "หมดเวลาเข้าสู่ระบบ — ล็อกอินใหม่" }];
  }
  const user = String(b.user || "").trim();
  const pass = String(b.pass || "");
  if (!USER_RE.test(user)) return [400, { ok: false, msg: "Username 3-16 ตัว (ภาษาอังกฤษ/ตัวเลขเท่านั้น)" }];
  if (pass.length < 4 || pass.length > 64) return [400, { ok: false, msg: "Password 4-64 ตัว" }];
  const key = "sof:acct:" + user.toLowerCase();
  if (action === "register") {
    const salt = crypto.randomBytes(16).toString("hex");
    const rec = JSON.stringify({ user, salt, hash: hashPw(pass, salt), created: Date.now() });
    if (!(await store.setnx(key, rec))) return [409, { ok: false, msg: "มี Username นี้แล้ว" }];
    return [200, { ok: true, user, token: await issue(user), dev: user === DEV_ID, msg: "สมัครสำเร็จ" }];
  }
  if (action === "login") {
    const raw = await store.get(key);
    const rec = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    if (!rec) return [401, { ok: false, msg: "Username หรือ Password ไม่ถูกต้อง" }];
    const h = hashPw(pass, rec.salt);
    if (!crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(rec.hash, "hex"))) return [401, { ok: false, msg: "Username หรือ Password ไม่ถูกต้อง" }];
    // v35: สถิติสำหรับหน้าผู้ดูแล (ล็อกอินล่าสุด / จำนวนครั้ง) — ไม่เก็บ IP
    rec.lastLogin = Date.now();
    rec.logins = (Number(rec.logins) || 0) + 1;
    await store.set(key, JSON.stringify(rec));
    return [200, { ok: true, user: rec.user, token: await issue(rec.user), dev: rec.user === DEV_ID, admin: isAdmin(rec.user) }];
  }
  return [400, { ok: false, msg: "action?" }];
}
