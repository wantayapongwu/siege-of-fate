// lib/trade.js -- v80.7: เซิร์ฟเวอร์เป็นตัวกลางการเทรด
//
// ที่มา (ข้อ 1 ของเจ้าของเกม): เดิมการเทรดคุยกันตรงๆ ระหว่างเครื่องผู้เล่นสองเครื่อง
//   เซิร์ฟเวอร์ไม่เคยรู้ว่าใครให้อะไรใคร -> ฝั่งหนึ่งเสกของขึ้นมาแล้วส่งให้อีกฝ่ายก็ได้
//   และของชิ้นเดียวส่งให้หลายคนพร้อมกันก็ได้ (ก๊อปของ)
//
// ของใหม่: ก่อนจะสลับของจริง ทั้งสองฝ่ายต้องมาลงทะเบียนที่นี่
//   1) ต่างคนต่างยื่นข้อเสนอ (offer) — เซิร์ฟเวอร์ตรวจว่า "ของอยู่ในเซฟฝั่งเซิร์ฟเวอร์ของคนยื่นจริง"
//      และ "ทะเบียนเจ้าของไอเทมบอกว่าเป็นของเขาจริง" (lib/anticheat.js)
//   2) ทั้งคู่กดยืนยัน (commit) — เซิร์ฟเวอร์ย้ายทะเบียนเจ้าของให้อีกฝ่าย แล้วออก "ใบโอน"
//      เซฟของผู้รับถึงจะผ่านด่านไปได้ ส่วนผู้ให้จะเก็บของชิ้นนั้นไว้ไม่ได้อีก
//
// POST /api/trade
//   {action:"offer",  token, with:<ชื่อบัญชีคู่เทรด>, items:[uid...], gold}
//   {action:"commit", token, with:<ชื่อบัญชีคู่เทรด>}
//   {action:"status", token, with:<ชื่อบัญชีคู่เทรด>}
//   {action:"cancel", token, with:<ชื่อบัญชีคู่เทรด>}
import * as store from "./store.js";
import { userOf } from "./accounts.js";
import { banInfo } from "./bans.js";
import { tradeGate } from "./gate.js";
import { itemsOfSave, itemFault, noteMove, bindUid, uidOwner } from "./anticheat.js";
import { ownerOf } from "./names.js";

export const MAX_ITEMS = 12;            // ของต่อหนึ่งข้อเสนอ (ตรงกับช่องเทรดในเกม)
export const MAX_GOLD = 2_000_000_000;
export const DEAL_TTL = 300;            // ข้อเสนอค้างได้ 5 นาที

// คีย์ของดีลหนึ่งคู่ (เรียงชื่อให้คงที่ ไม่ว่าใครเป็นคนเรียก)
export function dealKey(a, b) {
  const [x, y] = [String(a).toLowerCase(), String(b).toLowerCase()].sort();
  return "sof:trade:" + x + "|" + y;
}

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

/** ไอเทมทั้งหมดที่บัญชีนี้มีอยู่จริงตามเซฟฝั่งเซิร์ฟเวอร์ -> Map(uid -> item) */
export async function ownedItems(user) {
  const raw = await store.get("sof:save:" + String(user).toLowerCase());
  const rec = parse(raw);
  const out = new Map();
  if (!rec || !rec.files) return out;
  const { items } = itemsOfSave({ files: rec.files });
  for (const { it } of items) {
    const uid = it && it.uid ? String(it.uid) : "";
    if (uid && !out.has(uid)) out.set(uid, it);
  }
  return out;
}

/** ตรวจข้อเสนอของฝ่ายหนึ่ง -> {ok, msg, items:[{uid,item}]} */
export async function verifyOffer(user, uids, gold) {
  const list = Array.isArray(uids) ? uids.map((x) => String(x)) : [];
  if (list.length > MAX_ITEMS) return { ok: false, msg: `ของเกิน ${MAX_ITEMS} ชิ้นต่อครั้ง` };
  if (new Set(list).size !== list.length) return { ok: false, msg: "มี uid ซ้ำในข้อเสนอเดียวกัน" };
  const g = Number(gold) || 0;
  if (!Number.isFinite(g) || g < 0 || g > MAX_GOLD) return { ok: false, msg: "จำนวนเงินไม่ถูกต้อง" };
  const owned = await ownedItems(user);
  const items = [];
  for (const uid of list) {
    const it = owned.get(uid);
    if (!it) return { ok: false, msg: `ไม่พบของชิ้น ${uid} ในเซฟฝั่งเซิร์ฟเวอร์ของ ${user} (บันทึกเกมก่อนเทรด)` };
    const f = itemFault(it, "ของที่ยื่นเทรด");
    if (f) return { ok: false, msg: f };
    const owner = await uidOwner(uid);
    if (owner && owner.toLowerCase() !== String(user).toLowerCase())
      return { ok: false, msg: `ของชิ้น ${uid} อยู่ในทะเบียนของบัญชีอื่น` };
    items.push({ uid, item: it });
  }
  return { ok: true, msg: "", items, gold: g };
}

export async function handleTrade(method, body, headers) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const b = body && typeof body === "object" ? body : {};
  const me = await userOf(String(b.token || ""));
  if (!me) return [401, { ok: false, msg: "หมดเวลาเข้าสู่ระบบ — ล็อกอินใหม่" }];
  if (await banInfo(me)) return [403, { ok: false, msg: "บัญชีนี้ถูกระงับ" }];
  // คู่เทรดส่งมาเป็น "ชื่อตัวละคร" (ฝั่งเกมรู้แค่ชื่อนี้) -> แปลงเป็นบัญชีด้วยทะเบียนชื่อ
  // ถ้าไม่พบในทะเบียน ให้ถือว่าเป็นชื่อบัญชีโดยตรง (ใช้ในชุดทดสอบ)
  const asked = String(b.with || "").trim();
  const other = (await ownerOf(asked)) || asked;
  if (!other || other.toLowerCase() === me.toLowerCase())
    return [400, { ok: false, msg: "ระบุคู่เทรดไม่ถูกต้อง" }];
  if ((await store.hit("sof:trrate:" + me.toLowerCase(), 10)) > 30)
    return [429, { ok: false, msg: "เทรดถี่เกินไป" }];

  const action = String(b.action || "");
  const key = dealKey(me, other);
  const mine = me.toLowerCase();
  const theirs = other.toLowerCase();

  if (action === "cancel") {
    await store.del(key);
    return [200, { ok: true, cancelled: true }];
  }

  const deal = parse(await store.get(key)) || { offers: {}, commits: {}, t: Date.now() };

  if (action === "status") {
    return [200, { ok: true, deal: { offers: deal.offers, commits: deal.commits } }];
  }

  if (action === "offer") {
    // ทั้งสองฝ่ายต้องผ่านด่านบัญชีก่อน (เหมือนคลังกิลด์)
    for (const u of [me, other]) {
      const g = await tradeGate(u);
      if (!g.ok) return [403, { ok: false, msg: `${u}: ${g.reason}` }];
    }
    const v = await verifyOffer(me, b.items, b.gold);
    if (!v.ok) return [409, { ok: false, msg: v.msg }];
    deal.offers[mine] = { uids: v.items.map((x) => x.uid), gold: v.gold, t: Date.now() };
    deal.commits = {};              // ข้อเสนอเปลี่ยน = ต้องยืนยันกันใหม่ทั้งคู่
    deal.t = Date.now();
    await store.setex(key, DEAL_TTL, JSON.stringify(deal));
    return [200, { ok: true, offers: deal.offers }];
  }

  if (action === "commit") {
    if (!deal.offers[mine] || !deal.offers[theirs])
      return [409, { ok: false, msg: "ยังยื่นข้อเสนอไม่ครบทั้งสองฝ่าย" }];
    deal.commits[mine] = Date.now();
    if (!deal.commits[theirs]) {
      await store.setex(key, DEAL_TTL, JSON.stringify(deal));
      return [200, { ok: true, waiting: true, msg: "รออีกฝ่ายกดยืนยัน" }];
    }
    // ทั้งคู่ยืนยันแล้ว -> ตรวจซ้ำอีกรอบ (ของอาจถูกใช้ไประหว่างรอ) แล้วย้ายทะเบียน
    const a = await verifyOffer(me, deal.offers[mine].uids, deal.offers[mine].gold);
    if (!a.ok) { await store.del(key); return [409, { ok: false, msg: "ฝั่งคุณ: " + a.msg }]; }
    const c = await verifyOffer(other, deal.offers[theirs].uids, deal.offers[theirs].gold);
    if (!c.ok) { await store.del(key); return [409, { ok: false, msg: `ฝั่ง ${other}: ` + c.msg }]; }
    // กันกดพร้อมกันสองเครื่อง: ล็อกก่อนย้ายจริง
    const lock = await store.lockOwn(key + ":lock", 10);
    if (!lock) return [409, { ok: false, msg: "กำลังดำเนินการอยู่ ลองใหม่อีกครั้ง" }];
    try {
      for (const x of a.items) { await bindUid(x.uid, theirs); await noteMove(x.uid, theirs, "trade"); }
      for (const x of c.items) { await bindUid(x.uid, mine); await noteMove(x.uid, mine, "trade"); }
      await store.del(key);
      await store.setex("sof:tradelog:" + mine + ":" + Date.now(), 7 * 24 * 3600, JSON.stringify({
        with: theirs, gave: a.items.map((x) => x.uid), got: c.items.map((x) => x.uid),
        gave_gold: a.gold, got_gold: c.gold, t: Date.now() }));
    } finally {
      await store.unlockOwn(key + ":lock", lock);
    }
    return [200, { ok: true, done: true, got: c.items.map((x) => x.item), got_gold: c.gold,
      gave: a.items.map((x) => x.uid), gave_gold: a.gold }];
  }
  return [400, { ok: false, msg: "action?" }];
}
