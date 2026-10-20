// lib/save.js -- เซฟตัวละครบนเซิร์ฟเวอร์ (v30): ตัวละคร/คลังของบัญชีไม่หายเมื่อเปลี่ยนเครื่อง/เบราว์เซอร์/ล้างแคช
// POST {action:"get", token}            -> {ok, save: {t, files:{name: text}} | null}
// POST {action:"put", token, save}       -> {ok, t}   (save.t = เวลาที่เครื่องผู้เล่นบันทึก ms)
import * as store from "./store.js";
import { userOf } from "./accounts.js";

export const MAX_BYTES = 1_500_000;   // ~1.5 MB ต่อบัญชี
const FILE_RE = /^[A-Za-z0-9_.-]{1,80}$/;

export async function handleSave(method, body) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const b = body && typeof body === "object" ? body : {};
  const user = await userOf(String(b.token || ""));
  if (!user) return [401, { ok: false, msg: "หมดเวลาเข้าสู่ระบบ — ล็อกอินใหม่" }];
  const key = "sof:save:" + user.toLowerCase();
  const action = String(b.action || "");
  if (action === "get") {
    const raw = await store.get(key);
    const save = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    return [200, { ok: true, user, save }];
  }
  if (action === "put") {
    if ((await store.hit("sof:srate:" + user.toLowerCase(), 10)) > 6) return [429, { ok: false, msg: "บันทึกถี่เกินไป" }];
    const s = b.save && typeof b.save === "object" ? b.save : null;
    if (!s || typeof s.files !== "object" || s.files === null) return [400, { ok: false, msg: "save?" }];
    const files = {};
    for (const [name, text] of Object.entries(s.files)) {
      if (!FILE_RE.test(name) || typeof text !== "string") return [400, { ok: false, msg: "ชื่อไฟล์ไม่ถูกต้อง: " + name }];
      files[name] = text;
    }
    const rec = JSON.stringify({ t: Number(s.t) || Date.now(), files, saved_at: Date.now() });
    if (rec.length > MAX_BYTES) return [413, { ok: false, msg: "เซฟใหญ่เกินไป" }];
    await store.set(key, rec);
    return [200, { ok: true, t: Number(s.t) || Date.now() }];
  }
  return [400, { ok: false, msg: "action?" }];
}
