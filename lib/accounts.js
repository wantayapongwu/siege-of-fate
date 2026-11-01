// lib/accounts.js -- บัญชีผู้เล่นบนเซิร์ฟเวอร์ (v28.2): สมัคร / ล็อกอิน / ตรวจ token
// รหัสผ่านเก็บแบบ scrypt + salt สุ่ม (ไม่เก็บรหัสจริง) | token สุ่ม อายุ 30 วัน
import crypto from "node:crypto";
import * as store from "./store.js";
import { clientIp } from "./lobby.js";
import { startProgress } from "./anticheat.js";

const TOKEN_TTL = 30 * 24 * 3600;
const USER_RE = /^[A-Za-z0-9]{3,16}$/;
// v78.5: ความยาวรหัสผ่านขั้นต่ำของรหัสที่ "ตั้งใหม่" + กฎล็อกบัญชีเมื่อเดารหัสรัว
export const PASS_MIN = 8;
const FAIL_MAX = 10;              // ผิดได้กี่ครั้ง
const FAIL_WINDOW = 15 * 60;      // ในกี่วินาที
const LOCK_SEC = 15 * 60;         // เกินแล้วล็อกนานเท่าไร

const failKey = (u) => "sof:pwfail:" + String(u).toLowerCase();
const lockKey = (u) => "sof:pwlock:" + String(u).toLowerCase();

/** บัญชีนี้ถูกล็อกอยู่กี่วินาที (0 = ไม่ถูกล็อก) */
export async function lockLeft(user) {
  const v = await store.get(lockKey(user));
  if (!v) return 0;
  return Math.max(0, Math.ceil((Number(v) - Date.now()) / 1000));
}

/** นับครั้งที่รหัสผิด -> ครบเพดานแล้วล็อกบัญชีชั่วคราว */
async function noteFail(user) {
  const n = await store.hit(failKey(user), FAIL_WINDOW);
  if (n >= FAIL_MAX) await store.setex(lockKey(user), LOCK_SEC, String(Date.now() + LOCK_SEC * 1000));
  return n;
}

/** ล็อกอินผ่าน -> ล้างตัวนับทิ้ง */
async function clearFail(user) {
  await store.del(failKey(user));
  await store.del(lockKey(user));
}
export const DEV_ID = "l3ladeEmperRor";
// v35: ผู้ดูแลที่เปิดหน้า /admin ได้ = บัญชีผู้พัฒนา + รายชื่อเพิ่มใน env SOF_ADMIN_USERS (คั่นด้วย ,)
export function isAdmin(user) {
  if (!user) return false;
  const extra = String(process.env.SOF_ADMIN_USERS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const u = String(user).toLowerCase();
  return u === DEV_ID.toLowerCase() || extra.includes(u);
}

// v78.4: ชั้นที่สองของหน้า /admin -- ตั้ง env SOF_ADMIN_KEY แล้วต้องกรอกคีย์นี้เพิ่มจากการล็อกอิน
//        (รหัสผ่านบัญชีหลุด/ถูกหลอกเอาไป ก็ยังเปิดหลังบ้านไม่ได้ถ้าไม่มีคีย์) | ไม่ตั้ง = ทำงานเหมือนเดิม
export function adminKeyRequired() {
  return String(process.env.SOF_ADMIN_KEY || "").length > 0;
}

export function adminKeyOk(provided) {
  const want = String(process.env.SOF_ADMIN_KEY || "");
  if (!want) return true;
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashPw(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString("hex");
}

// v77: "ลืมรหัสผ่าน" โดยไม่ต้องใช้อีเมล -- ตอนสมัครจะได้ "รหัสกู้คืน" มาหนึ่งชุด เก็บไว้เอง
// เซิร์ฟเวอร์เก็บแค่ค่าแฮชของรหัสกู้คืน (เหมือนรหัสผ่าน) -> ใครเจาะฐานข้อมูลไปก็ใช้ไม่ได้
// ใช้แล้วรหัสเดิมหมดอายุทันที และได้รหัสใหม่มาแทน (ใช้ซ้ำไม่ได้)
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ตัด I O 0 1 ออก กันอ่านผิด
const CODE_GROUPS = 4, CODE_LEN = 4;

function newRecoveryCode() {
  const bytes = crypto.randomBytes(CODE_GROUPS * CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_GROUPS * CODE_LEN; i++) {
    if (i > 0 && i % CODE_LEN === 0) out += "-";
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** ตัดขีด/ช่องว่าง + ตัวพิมพ์ใหญ่ -> ผู้เล่นพิมพ์แบบไหนก็ตรงกัน */
export function normalizeCode(c) {
  return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** ตั้งรหัสกู้คืนชุดใหม่ให้เรคอร์ดนี้ -> คืนรหัสตัวจริง (โชว์ครั้งเดียว) */
function setRecovery(rec) {
  const code = newRecoveryCode();
  rec.rsalt = crypto.randomBytes(16).toString("hex");
  rec.rhash = hashPw(normalizeCode(code), rec.rsalt);
  rec.rset = Date.now();
  return code;
}

/** เทียบค่าแฮชแบบไม่รั่วเวลา (ความยาวไม่ตรง = ไม่ตรงแน่นอน) */
function sameHash(a, b) {
  const x = Buffer.from(String(a || ""), "hex");
  const y = Buffer.from(String(b || ""), "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
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
    if (!u) return [401, { ok: false, msg: "หมดเวลาเข้าสู่ระบบ — ล็อกอินใหม่" }];
    const raw = await store.get("sof:acct:" + u.toLowerCase());
    const rec = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    return [200, { ok: true, user: u, dev: u === DEV_ID, admin: isAdmin(u), has_recovery: !!(rec && rec.rhash) }];
  }
  // v77: บัญชีเก่าที่ยังไม่มีรหัสกู้คืน -> ขอชุดใหม่ได้ ต้องล็อกอินอยู่ + ยืนยันรหัสผ่านปัจจุบัน
  if (action === "newcode") {
    const u = await userOf(String(b.token || ""));
    if (!u) return [401, { ok: false, msg: "หมดเวลาเข้าสู่ระบบ — ล็อกอินใหม่" }];
    const k = "sof:acct:" + u.toLowerCase();
    const raw = await store.get(k);
    const rec = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    if (!rec) return [401, { ok: false, msg: "ไม่พบบัญชีนี้" }];
    if (!sameHash(hashPw(String(b.pass || ""), rec.salt), rec.hash))
      return [401, { ok: false, msg: "รหัสผ่านไม่ถูกต้อง" }];
    const code = setRecovery(rec);
    await store.set(k, JSON.stringify(rec));
    return [200, { ok: true, user: rec.user, recovery: code, msg: "เก็บรหัสกู้คืนนี้ไว้ให้ดี — ใช้ได้ครั้งเดียว" }];
  }
  const user = String(b.user || "").trim();
  const pass = String(b.pass || "");
  if (!USER_RE.test(user)) return [400, { ok: false, msg: "Username 3-16 ตัว (ภาษาอังกฤษ/ตัวเลขเท่านั้น)" }];
  // v78.5: รหัสผ่าน "ที่ตั้งใหม่" ต้องยาวอย่างน้อย 8 ตัว
  //        ตอนล็อกอินยังรับของเดิมที่สั้นกว่านั้น (ไม่งั้นบัญชีเก่าเข้าไม่ได้) แต่จะเตือนให้เปลี่ยน
  const setting = action === "register" || action === "forgot";
  const min = setting ? PASS_MIN : 1;
  if (pass.length < min || pass.length > 64)
    return [400, { ok: false, msg: setting ? ("Password ต้องยาวอย่างน้อย " + PASS_MIN + " ตัว (ไม่เกิน 64)") : "Password 1-64 ตัว" }];
  const key = "sof:acct:" + user.toLowerCase();
  // v78.5: เดารหัสผ่านของ "บัญชีใดบัญชีหนึ่ง" รัวๆ -> ล็อกบัญชีนั้นชั่วคราว (คนละชั้นกับลิมิตต่อ IP
  //        ซึ่งเลี่ยงได้ด้วยการเปลี่ยน IP ไปเรื่อยๆ)
  if (action === "login" || action === "forgot") {
    const left = await lockLeft(user);
    if (left > 0) return [429, { ok: false, msg: "ลองรหัสผิดหลายครั้งเกินไป — รออีก " + Math.ceil(left / 60) + " นาที", locked: left }];
  }
  if (action === "register") {
    const salt = crypto.randomBytes(16).toString("hex");
    const rec = { user, salt, hash: hashPw(pass, salt), created: Date.now() };
    const code = setRecovery(rec);   // v77: แถมรหัสกู้คืนมาตั้งแต่สมัคร (โชว์ครั้งเดียว)
    if (!(await store.setnx(key, JSON.stringify(rec)))) return [409, { ok: false, msg: "มี Username นี้แล้ว" }];
    await startProgress(user);   // v78.8 กฎ 1: บัญชีใหม่เริ่มที่เลเวล 1 เงิน 0 เสมอ (เวลามาจากเซิร์ฟเวอร์)
    return [200, { ok: true, user, token: await issue(user), dev: user === DEV_ID, recovery: code, msg: "สมัครสำเร็จ" }];
  }
  // v77: ลืมรหัสผ่าน -> ใช้ "รหัสกู้คืน" ที่ได้ตอนสมัคร ตั้งรหัสผ่านใหม่ได้เลย
  //      กันเดารหัสกู้คืน: ต่อบัญชี 5 ครั้ง/ชั่วโมง (นอกเหนือจากลิมิตต่อ IP ด้านบน)
  if (action === "forgot") {
    const code = normalizeCode(b.code);
    if (code.length < 8) return [400, { ok: false, msg: "กรอกรหัสกู้คืนที่ได้ตอนสมัคร" }];
    if ((await store.hit("sof:fgt:" + user.toLowerCase(), 3600)) > 5)
      return [429, { ok: false, msg: "ลองกู้รหัสบ่อยเกินไป รออีก 1 ชั่วโมง" }];
    const raw = await store.get(key);
    const rec = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    if (!rec || !rec.rhash) { await noteFail(user); return [401, { ok: false, msg: "บัญชีนี้ยังไม่มีรหัสกู้คืน — ติดต่อผู้ดูแล" }]; }
    if (!sameHash(hashPw(code, rec.rsalt), rec.rhash)) {
      await noteFail(user);
      return [401, { ok: false, msg: "รหัสกู้คืนไม่ถูกต้อง" }];
    }
    rec.salt = crypto.randomBytes(16).toString("hex");
    rec.hash = hashPw(pass, rec.salt);        // pass = รหัสผ่านใหม่ (ตรวจความยาวไปแล้วด้านบน)
    rec.pwreset = Date.now();
    const next = setRecovery(rec);            // รหัสกู้คืนเดิมใช้ไม่ได้อีก -> ได้ชุดใหม่
    await store.set(key, JSON.stringify(rec));
    await clearFail(user);
    return [200, { ok: true, user: rec.user, token: await issue(rec.user), dev: rec.user === DEV_ID,
      admin: isAdmin(rec.user), recovery: next, msg: "ตั้งรหัสผ่านใหม่แล้ว — เก็บรหัสกู้คืนชุดใหม่ไว้ด้วย" }];
  }
  if (action === "login") {
    const raw = await store.get(key);
    const rec = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    if (!rec) {
      await noteFail(user);
      return [401, { ok: false, msg: "Username หรือ Password ไม่ถูกต้อง" }];
    }
    if (!sameHash(hashPw(pass, rec.salt), rec.hash)) {
      const n = await noteFail(user);
      const left = FAIL_MAX - n;
      return [401, { ok: false, msg: left > 0 && left <= 3
        ? ("Username หรือ Password ไม่ถูกต้อง (เหลืออีก " + left + " ครั้งก่อนบัญชีถูกล็อกชั่วคราว)")
        : "Username หรือ Password ไม่ถูกต้อง" }];
    }
    await clearFail(user);
    // v35: สถิติสำหรับหน้าผู้ดูแล (ล็อกอินล่าสุด / จำนวนครั้ง) — ไม่เก็บ IP
    rec.lastLogin = Date.now();
    rec.logins = (Number(rec.logins) || 0) + 1;
    await store.set(key, JSON.stringify(rec));
    return [200, { ok: true, user: rec.user, token: await issue(rec.user), dev: rec.user === DEV_ID,
      admin: isAdmin(rec.user), has_recovery: !!rec.rhash,
      weak_password: pass.length < PASS_MIN }];   // v78.5: รหัสเก่าสั้นกว่าเกณฑ์ใหม่ -> เกมเตือนให้เปลี่ยน
  }
  return [400, { ok: false, msg: "action?" }];
}
