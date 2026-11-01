// lib/reset.js -- v78.6: ล้างข้อมูลผู้เล่นทั้งเซิร์ฟเวอร์ (เปิดเบต้ารอบใหม่)
//
// ใช้ตอน "ปิดเบต้าแล้วเริ่มใหม่" — ทุกคนสมัครใหม่ เริ่มจากศูนย์เหมือนเพิ่งเปิดเกม
// เรียกได้จากหน้า /admin เท่านั้น และต้องผ่านสามชั้น: บัญชีผู้ดูแล + คีย์ผู้ดูแล + พิมพ์คำยืนยัน
//
// *** ลบแล้วเอาคืนไม่ได้ *** ไม่มีถังขยะ ไม่มีสำรองอัตโนมัติ
// ก่อนใช้จริงควรกด "ดูก่อนว่าจะลบอะไร" (dry_run) เพื่อเห็นจำนวนก่อนเสมอ
import * as store from "./store.js";
import { isAdmin } from "./accounts.js";
import { startProgress } from "./anticheat.js";

// กลุ่มข้อมูลที่ถือว่าเป็น "ข้อมูลผู้เล่น"
// saves = ความคืบหน้าในเกม | accounts = ตัวบัญชีและการล็อกอิน | shop = ของที่ซื้อ/ประวัติสั่งซื้อ
export const GROUPS = {
  saves: {
    label: "เซฟในเกม (ตัวละคร/ของ/คลัง/กิลด์)",
    prefixes: ["sof:save:", "sof:cname:", "sof:gstash:", "sof:guild:", "sof:prog:", "sof:uid:", "sof:cheatflag:",
      "sof:dgr:", "sof:dgrday:"],
  },
  accounts: {
    label: "บัญชีและการล็อกอิน",
    prefixes: ["sof:acct:", "sof:tok:", "sof:pwfail:", "sof:pwlock:", "sof:fgt:", "sof:arate:", "sof:ban:"],
  },
  shop: {
    label: "ของที่ซื้อ / ประวัติสั่งซื้อ",
    prefixes: ["sof:ent:", "sof:tx:", "sof:shoprate:", "sof:shopstart:"],
    sets: ["sof:txs"],
  },
  rooms: {
    label: "ห้องที่เปิดค้าง / สัญญาณ WebRTC",
    prefixes: ["sof:room:", "sof:sig:", "sof:sigkey:", "sof:sigwho:"],
    sets: ["sof:rooms"],
  },
};

export const SCOPES = {
  all: ["saves", "accounts", "shop", "rooms"],      // เหมือนเปิดเกมใหม่: ต้องสมัครใหม่ทุกคน
  saves: ["saves", "rooms"],                        // เก็บบัญชีไว้: ล็อกอินเดิมได้ แต่เริ่มตัวละครใหม่
};

export const CONFIRM_WORD = "RESET";

// v78.7: "เวลาที่รีเซ็ตล่าสุด" — คีย์นี้ไม่อยู่ในกลุ่มไหนเลย จึงไม่ถูกล้างไปพร้อมข้อมูลผู้เล่น
// ใช้กันเซฟเก่าที่ยังค้างอยู่ในเครื่องผู้เล่นเด้งกลับขึ้นมาหลังรีเซ็ต (ดู cloud_save.gd)
export const EPOCH_KEY = "sof:epoch";

export async function epoch() {
  return Number(await store.get(EPOCH_KEY)) || 0;
}

/** คีย์ของบัญชีที่ต้องเก็บไว้ (ไม่ให้ถูกล้างไปด้วย) */
function keptKeys(user) {
  const u = String(user || "").toLowerCase();
  if (!u) return new Set();
  return new Set(["sof:acct:" + u, "sof:ent:" + u]);
}

/**
 * @param scope     "all" | "saves"
 * @param keepUser  ชื่อบัญชีที่จะเว้นไว้ ("" = ไม่เว้นใคร)
 * @param dryRun    true = แค่นับ ไม่ลบจริง
 */
export async function wipe({ scope = "all", keepUser = "", dryRun = true } = {}) {
  const groups = SCOPES[scope];
  if (!groups) return { ok: false, msg: "scope?" };
  const keep = keptKeys(keepUser);
  const out = { ok: true, scope, dry_run: !!dryRun, kept_account: keepUser || null, groups: {}, total: 0, kept: 0 };

  for (const g of groups) {
    const def = GROUPS[g];
    let n = 0, kept = 0;
    for (const p of def.prefixes) {
      const keys = await store.scanPrefix(p);
      for (const k of keys) {
        if (keep.has(k)) { kept++; continue; }
        if (!dryRun) await store.del(k);
        n++;
      }
    }
    for (const s of def.sets || []) {
      const members = await store.smembers(s);
      if (!dryRun) {
        for (const m of members) await store.srem(s, m);
      }
      n += members.length;
    }
    out.groups[g] = { label: def.label, keys: n, kept };
    out.total += n;
    out.kept += kept;
  }

  // v79.0: ฐานกันโกงถูกล้างไปพร้อมกัน (sof:prog:*) -> บัญชีที่ยังเหลือจะ "ไม่มีอะไรให้เทียบ" หนึ่งครั้ง
  //        = ช่องให้อัปเซฟเลเวล 100 เข้ามาได้รอบเดียวหลังรีเซ็ต
  //        ตั้งฐานใหม่ให้ทุกบัญชีที่เหลือ (first: true) -> เซฟแรกหลังรีเซ็ตต้องเป็นตัวละครใหม่จริง
  const accts = await store.scanPrefix("sof:acct:");
  out.reseeded = accts.length;
  if (!dryRun) {
    for (const k of accts) await startProgress(k.slice("sof:acct:".length), Date.now());
  }

  // token ของบัญชีที่เว้นไว้ก็หายไปด้วย (คีย์ token ไม่ได้ผูกกับชื่อบัญชี) -> ต้องล็อกอินใหม่หนึ่งครั้ง
  if (!dryRun) {
    // ปักหมุดเวลารีเซ็ต -> เซฟเก่าในเครื่องผู้เล่น (เก่ากว่าหมุดนี้) จะถูกทิ้ง ไม่อัปกลับขึ้นมา
    out.epoch = Date.now();
    await store.set(EPOCH_KEY, String(out.epoch));
    out.note = "เสร็จแล้ว — ถ้าค้างอยู่ในเกม ให้ออกแล้วล็อกอินใหม่";
  }
  return out;
}

/** ทางเข้าจากหน้า /admin (ตรวจสิทธิ์มาจาก handleAdmin แล้ว ที่นี่ตรวจคำยืนยันซ้ำอีกชั้น) */
export async function handleWipe(who, b) {
  if (!isAdmin(who)) return [403, { ok: false, msg: "ไม่ใช่ผู้ดูแล" }];
  const dry = b.dry_run !== false;
  if (!dry && String(b.confirm || "") !== CONFIRM_WORD)
    return [400, { ok: false, msg: 'ต้องพิมพ์ "' + CONFIRM_WORD + '" เพื่อยืนยัน', need_confirm: CONFIRM_WORD }];
  const r = await wipe({ scope: String(b.scope || "all"), keepUser: String(b.keep_user || ""), dryRun: dry });
  return r.ok ? [200, r] : [400, r];
}
