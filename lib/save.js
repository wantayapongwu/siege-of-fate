// lib/save.js -- เซฟตัวละครบนเซิร์ฟเวอร์ (v30): ตัวละคร/คลังของบัญชีไม่หายเมื่อเปลี่ยนเครื่อง/เบราว์เซอร์/ล้างแคช
// POST {action:"get", token}            -> {ok, save: {t, files:{name: text}} | null}
// POST {action:"put", token, save}       -> {ok, t}   (save.t = เวลาที่เครื่องผู้เล่นบันทึก ms)
import * as store from "./store.js";
import { userOf } from "./accounts.js";
import { checkSave, rememberProgress, flag } from "./anticheat.js";
import { epoch } from "./reset.js";

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
    // v78.7: ส่ง "เวลาที่เซิร์ฟเวอร์ถูกรีเซ็ตล่าสุด" ไปด้วย -> ฝั่งเกมทิ้งเซฟในเครื่องที่เก่ากว่านี้
    return [200, { ok: true, user, save, epoch: await epoch() }];
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
    // v78.7: เซฟที่บันทึกไว้ "ก่อน" เซิร์ฟเวอร์ถูกรีเซ็ต = ของรอบเบต้าที่แล้ว ไม่รับขึ้นมาอีก
    //        (กันเซฟเก่าในเบราว์เซอร์ผู้เล่นเด้งกลับหลังรีเซ็ต) — ตรวจที่เซิร์ฟเวอร์ด้วย ไม่พึ่งฝั่งเกมอย่างเดียว
    const ep = await epoch();
    const savedAt = Number(s.t) || 0;
    if (ep > 0 && savedAt > 0 && savedAt < ep)
      return [409, { ok: false, msg: "เซฟนี้เป็นของก่อนเซิร์ฟเวอร์ถูกรีเซ็ต — เริ่มตัวละครใหม่ได้เลย", stale: true, epoch: ep }];
    // v78.4: ก่อนเก็บ ต้องผ่านด่าน "ความเป็นไปได้" ก่อน (เดิมรับทุกอย่างที่ส่งมา = เขียนเลเวล/เงินเองได้)
    const now = Date.now();
    const verdict = await checkSave(user, { files }, now);
    if (!verdict.ok) {
      const n = await flag(user, verdict.reasons, now);
      return [409, { ok: false, msg: "เซฟนี้มีค่าที่เป็นไปไม่ได้ จึงไม่ถูกบันทึก", reasons: verdict.reasons, strikes: n }];
    }
    await store.set(key, rec);
    await rememberProgress(user, verdict.prog, now);
    // v78.5: ของชิ้นเดียวกันโผล่สองบัญชีพร้อมกัน -> บันทึกธงไว้ให้ /admin ดู (ไม่ปฏิเสธ เพราะเทรดของกันได้จริง)
    if (verdict.dups && verdict.dups.length) await flag(user, verdict.dups.map((x) => "ของซ้ำ: " + x), now);
    return [200, { ok: true, t: Number(s.t) || Date.now() }];
  }
  return [400, { ok: false, msg: "action?" }];
}
