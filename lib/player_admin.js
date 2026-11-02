// lib/player_admin.js -- v80.26: เครื่องมือรายบัญชีในหน้า /admin
//
// สองเรื่องที่เจ้าของเกมขอ:
//   1) "ข้อมูลการแบนอ่านไม่รู้เรื่อง" -> banReport() รวมทุกอย่างที่ต้องรู้ไว้ที่เดียว
//      พร้อมคำอธิบายว่ากฎข้อนั้นหมายความว่าอะไร และควรทำอะไรต่อ
//   2) "อยากให้เพื่อนใช้ไอดีเดิมเทสต่อ" -> resetPlayer() ล้างทีละส่วนได้
//      (ธง / เลเวล / ของ / ประวัติความก้าวหน้า) ไม่ต้องลบบัญชีทิ้งทั้งใบ
//
// ทุกฟังก์ชันในไฟล์นี้ถูกเรียกหลังผ่าน "บัญชีผู้ดูแล + คีย์ผู้ดูแล" ใน handleAdmin แล้ว
import * as store from "./store.js";
import { banInfo, listBans, unban, autoBanOn, autoBanFlags, AUTO_REASON } from "./bans.js";
import {
  flagKey, progKey, progressOf, rememberProgress, startProgress, faultKinds,
  levelBaseline, bucketsOfChar, maxLevelFrom, QUEST_EXP_MAX,
  STRIKE_GAP_MS, STRIKE_MAX_PER_EVENT, FIRST_LEVEL_MAX,
} from "./anticheat.js";

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const USER_RE = /^[a-z0-9]{3,16}$/;

// ชื่อกฎ -> อธิบายให้ผู้ดูแลเข้าใจว่าเกิดจากอะไร และมักเป็นของจริงหรือของพลาด
export const RULE_HELP = {
  "เลเวลเกินที่ฆ่ามา": {
    what: "เลเวลที่ส่งมาสูงกว่าที่มอนในประวัติจะพาไปถึงได้",
    why: "เซิร์ฟเวอร์ไล่สูตร EXP เดียวกับในเกมจากประวัติ 'ฆ่ามอนเลเวลไหนไปกี่ตัว'",
    legit: "ตัวละครที่โตมาก่อนเวอร์ชันที่เริ่มเก็บประวัติ (v79.1) จะไม่มีประวัติย้อนหลัง — v80.25 แก้ด้วยเส้นฐานเลเวลแล้ว",
    fix: "ถ้าเป็นผู้เล่นจริง: กด 'ตั้งเส้นฐานใหม่จากเซฟปัจจุบัน' แล้วล้างธง",
  },
  "ฆ่าเกินเวลาเล่น": {
    what: "จำนวนมอนที่ฆ่าเพิ่มขึ้นเร็วกว่าที่เวลาเล่นจริงจะทำได้",
    why: "ผูกจำนวนที่ฆ่ากับจำนวนชั่วโมงที่มีเซฟเข้ามาจริง",
    legit: "เล่นปาร์ตี้ใหญ่ที่ฟาร์มหนักมากอาจชนได้ แต่ไม่บ่อย",
    fix: "ดูประวัติการชนกฎด้านล่างว่าชนซ้ำๆ หรือครั้งเดียว",
  },
  "เซฟแรกของบัญชีใหม่": {
    what: "บัญชีที่เพิ่งสมัครส่งเซฟแรกที่ไม่ใช่ตัวละครใหม่",
    why: "เซฟแรกต้องเลเวลไม่เกิน " + FIRST_LEVEL_MAX + " เงินและจำนวนที่ฆ่าต้องน้อย",
    legit: "เกิดได้ถ้าผู้ดูแลล้างประวัติเป็น 'เหมือนบัญชีใหม่' แต่ยังไม่ล้างเลเวล/ของ",
    fix: "ล้างเลเวลและของให้ครบ หรือใช้ 'ตั้งเส้นฐานใหม่' แทนการล้างเป็นบัญชีใหม่",
  },
  "เกินเพดานตายตัว": {
    what: "มีค่าที่เกินเพดานของเกมเอง (เขียนเซฟเองแน่ๆ)",
    why: "ค่าพวกนี้ในเกมไม่มีทางเกิน ไม่ว่าจะเล่นยังไง",
    legit: "แทบไม่มี — ยกเว้นเกมเองมีบั๊กที่ทำให้ค่าทะลุ",
    fix: "ดูเหตุผลเต็มด้านล่างว่าค่าไหนเกิน ถ้าเป็นบั๊กของเกมให้แก้เกมแล้วล้างธง",
  },
  "แต้มสถานะ": { what: "แต้มสถานะที่ลงไว้ไม่ตรงกับเลเวล", why: "แต้มที่ได้ทั้งหมดคิดจากเลเวล", legit: "น้อย", fix: "ดูเหตุผลเต็มด้านล่าง" },
  "แต้มต้นไม้": { what: "แต้มต้นไม้พรสวรรค์ไม่ตรงกับเลเวล", why: "แต้มที่ได้ทั้งหมดคิดจากเลเวล", legit: "น้อย", fix: "ดูเหตุผลเต็มด้านล่าง" },
  เผ่า: { what: "ปลดล็อกโหนดเผ่าโดยยังไม่ผ่านบททดสอบ", why: "โหนดเผ่าต้องผ่านบททดสอบก่อน", legit: "น้อย", fix: "ดูเหตุผลเต็มด้านล่าง" },
  รูน: { what: "รูนบนกระดาน/ในถุงเกินที่เป็นไปได้", why: "จำนวนรูนมีเพดานตามความคืบหน้า", legit: "น้อย", fix: "ดูเหตุผลเต็มด้านล่าง" },
};

/** รายงานการแบน + ธง + ความก้าวหน้า ของบัญชีหนึ่ง (อ่านรู้เรื่อง ไม่ต้องเดา) */
export async function banReport(user) {
  const u = String(user || "").trim().toLowerCase();
  if (!USER_RE.test(u)) return null;
  const acct = parse(await store.get("sof:acct:" + u));
  if (!acct) return null;
  const ban = await banInfo(u);
  const flags = parse(await store.get(flagKey(u))) || null;
  const prog = parse(await store.get(progKey(u))) || null;
  const save = parse(await store.get("sof:save:" + u));

  // ---- ตัวละครในเซฟตอนนี้ เทียบกับที่ประวัติพาไปได้ (คือตัวเลขที่กฎใช้ตัดสินจริงๆ) ----
  const chars = [];
  const list = charList(save);
  for (const c of list) {
    const bk = bucketsOfChar(c);
    const base = levelBaseline(prog, String(c.name || ""));
    chars.push({
      name: String(c.name || "?"),
      level: num(c.level),
      kills: num(c.kills),
      hist_total: bk.total,
      baseline: base,
      reach: maxLevelFrom(bk.buckets, QUEST_EXP_MAX, Math.max(0, num(c.kills) - bk.total), Math.max(1, base)),
      gold: num(c.inventory && c.inventory.gold),
    });
  }

  // ---- ประวัติการชนกฎ: แปลงเป็นข้อความที่อ่านรู้เรื่อง ----
  const events = (flags && Array.isArray(flags.items) ? flags.items : []).slice().reverse().map((e) => ({
    at: num(e.t),
    hard: !!e.hard,
    kinds: faultKinds(e.reasons || []),
    reasons: (e.reasons || []).map(String),
  }));
  const kindCount = {};
  for (const e of events) for (const k of e.kinds) kindCount[k] = (kindCount[k] || 0) + 1;
  const kinds = Object.entries(kindCount)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, times]) => ({ kind, times, help: RULE_HELP[kind] || null }));

  const strikes = flags ? num(flags.strikes) : 0;
  const limit = autoBanOn() ? autoBanFlags() : 0;
  return {
    user: acct.user || u,
    account: { created: num(acct.created), last_login: num(acct.lastLogin), logins: num(acct.logins) },
    ban: ban
      ? {
          banned: true,
          by: String(ban.by || ""),
          by_text: String(ban.by) === "auto" ? "ระบบแบนอัตโนมัติ" : "ผู้ดูแล " + String(ban.by || "?"),
          at: num(ban.at),
          reason: String(ban.reason || ""),
          until: num(ban.until),
          permanent: !num(ban.until),
          minutes_left: num(ban.until) ? Math.max(0, Math.ceil((num(ban.until) - Date.now()) / 60000)) : 0,
          auto_reason_text: String(ban.reason || "").startsWith(AUTO_REASON)
            ? "โดนแบนเพราะเซฟถูกปฏิเสธซ้ำจนครบเพดาน " + limit + " ครั้ง ไม่ใช่ผู้ดูแลสั่งแบนเอง"
            : "",
        }
      : { banned: false },
    strikes: {
      count: strikes,
      limit,
      left: limit ? Math.max(0, limit - strikes) : 0,
      autoban_on: autoBanOn(),
      rejects: flags ? num(flags.n) : 0,
      first_at: flags ? num(flags.first) : 0,
      last_at: flags ? num(flags.last) : 0,
      last_kinds: flags && Array.isArray(flags.last_kinds) ? flags.last_kinds : [],
      gap_minutes: STRIKE_GAP_MS / 60000,
      max_per_save: STRIKE_MAX_PER_EVENT,
      note:
        "ธงนับได้ไม่ถี่กว่า " + STRIKE_GAP_MS / 60000 + " นาที และนับแค่กรณีที่ค่า 'เขียนเองแน่ๆ' เท่านั้น" +
        (limit ? " ครบ " + limit + " ครั้งแล้วระบบแบนให้เอง" : " (ปิดการแบนอัตโนมัติไว้)"),
    },
    kinds,
    events,
    progress: prog
      ? {
          level: num(prog.level), gold: num(prog.gold), exp: num(prog.exp), kills: num(prog.kills),
          bosses: num(prog.bosses), at: num(prog.t), hours_played: num(prog.ph),
          first_seen: num(prog.ph_first), kills0: num(prog.kills0),
          hist_seen: !!num(prog.hist_seen), baselines: prog.lvl0 && typeof prog.lvl0 === "object" ? prog.lvl0 : {},
          first: !!prog.first,
        }
      : null,
    progress_note: prog
      ? prog.first
        ? "ระเบียนบอกว่า 'ยังไม่เคยส่งเซฟ' -> เซฟแรกต้องเป็นตัวละครใหม่ (เลเวลไม่เกิน " + FIRST_LEVEL_MAX + ")"
        : num(prog.hist_seen)
          ? "บัญชีนี้ส่งประวัติเลเวลมอนแล้ว -> กฎ 'เลเวลเกินที่ฆ่ามา' ทำงานกับบัญชีนี้"
          : "ยังไม่เคยส่งประวัติเลเวลมอน -> กฎ 'เลเวลเกินที่ฆ่ามา' ยังไม่ทำงาน"
      : "ไม่มีระเบียนความก้าวหน้า (ยังไม่เคยส่งเซฟผ่าน หรือถูกล้างไปแล้ว)",
    characters: chars,
    saved_at: save ? num(save.saved_at || save.t) : 0,
  };
}

function charList(save) {
  if (!save || !save.files) return [];
  const e = Object.entries(save.files).find(([k]) => k.startsWith("characters_"));
  const l = e ? parse(e[1]) : null;
  return Array.isArray(l) ? l.filter((c) => c && typeof c === "object" && c.name) : [];
}

function fileEntry(save, prefix) {
  if (!save || !save.files) return null;
  const e = Object.entries(save.files).find(([k]) => k.startsWith(prefix));
  return e ? { key: e[0], data: parse(e[1]) } : null;
}

// ของที่ซื้อด้วยเงินจริงอยู่ใน wardrobe/costume -> ล้าง "ของ" ต้องไม่แตะสองช่องนี้
const KEEP_ON_ITEM_WIPE = ["wardrobe", "costume", "show_costume", "show_helm"];

/**
 * ล้างข้อมูลผู้เล่นทีละส่วน (บัญชีเดิม ล็อกอินเดิม)
 * @param opts {flags, unban, rebase, level, items, fresh, dry_run}
 */
export async function resetPlayer(user, opts = {}) {
  const u = String(user || "").trim().toLowerCase();
  if (!USER_RE.test(u)) return { ok: false, msg: "ชื่อบัญชีไม่ถูกต้อง" };
  const acct = parse(await store.get("sof:acct:" + u));
  if (!acct) return { ok: false, msg: "ไม่พบบัญชีนี้" };
  const dry = !!opts.dry_run;
  const did = [];
  const warn = [];

  if (opts.flags) {
    const f = parse(await store.get(flagKey(u)));
    did.push("ล้างธงกันโกง" + (f ? " (เดิม " + num(f.strikes) + " ครั้ง / ถูกปฏิเสธ " + num(f.n) + " ครั้ง)" : " (ไม่มีธงอยู่แล้ว)"));
    if (!dry) await store.del(flagKey(u));
  }
  if (opts.unban) {
    const b = await banInfo(u);
    did.push(b ? "ปลดแบน (เหตุผลเดิม: " + (b.reason || "-") + ")" : "ไม่ได้ถูกแบนอยู่");
    if (!dry && b) await unban(u);
  }

  // ---- แก้ตัวเซฟ: เลเวล / ของ ----
  let save = parse(await store.get("sof:save:" + u));
  let touched = false;
  if ((opts.level || opts.items) && !save) warn.push("ไม่มีเซฟบนเซิร์ฟเวอร์ -> ข้ามการล้างเลเวล/ของ");
  if ((opts.level || opts.items) && save) {
    const ce = fileEntry(save, "characters_");
    if (ce && Array.isArray(ce.data)) {
      let nlv = 0, nit = 0;
      for (const c of ce.data) {
        if (!c || typeof c !== "object") continue;
        if (opts.level) {
          c.level = 1; c.exp = 0; c.alloc = {};
          c.kills = 0; c.exp_kills = 0; c.exp_kills_lv = {};
          c.boss_kills = {}; c.boss_exp_kills = 0; c.dungeon_resets = 0;
          nlv++;
        }
        if (opts.items) {
          const inv = c.inventory && typeof c.inventory === "object" ? c.inventory : {};
          const kept = {};
          for (const k of KEEP_ON_ITEM_WIPE) if (inv[k] !== undefined) kept[k] = inv[k];
          c.inventory = { gold: 0, ...kept };
          nit++;
        }
      }
      if (opts.level) did.push("ล้างเลเวลเป็น 1 และล้างตัวนับการฆ่า/ประวัติมอน (" + nlv + " ตัวละคร)");
      if (opts.items) did.push("ล้างของในกระเป๋า/ที่สวมใส่/ขวดยา/ออร์บ และเงินเป็น 0 (" + nit + " ตัวละคร) — คอสตูมที่ซื้อไว้ไม่ถูกลบ");
      if (!dry) { save.files[ce.key] = JSON.stringify(ce.data); touched = true; }
    } else {
      warn.push("อ่านไฟล์ตัวละครในเซฟไม่ได้ -> ข้ามการล้างเลเวล/ของ");
    }
    if (opts.items) {
      const se = fileEntry(save, "stash_");
      if (se) {
        did.push("ล้างคลังเก็บของ");
        if (!dry) { save.files[se.key] = JSON.stringify({}); touched = true; }
      }
    }
  }
  if (!dry && touched) {
    save.saved_at = Date.now();
    await store.set("sof:save:" + u, JSON.stringify(save));
  }

  // ---- ระเบียนความก้าวหน้าของด่านกันโกง ----
  if (opts.fresh) {
    did.push("ตั้งระเบียนความก้าวหน้าเป็น 'บัญชีใหม่' (เซฟแรกต่อไปต้องเลเวลไม่เกิน " + FIRST_LEVEL_MAX + ")");
    if (!(opts.level && opts.items)) warn.push("เลือก 'เหมือนบัญชีใหม่' แต่ไม่ได้ล้างเลเวล+ของ -> เซฟถัดไปจะถูกปฏิเสธ");
    if (!dry) await startProgress(u, Date.now());
  } else if (opts.rebase) {
    const fresh = parse(await store.get("sof:save:" + u));
    if (!fresh) {
      warn.push("ไม่มีเซฟบนเซิร์ฟเวอร์ -> ตั้งเส้นฐานใหม่ไม่ได้");
    } else {
      const prog = progressOf(fresh);
      did.push(
        "ตั้งเส้นฐานใหม่จากเซฟปัจจุบัน (เลเวล " + num(prog.max_level) + " / ฆ่า " + num(prog.kills) +
        " ตัว) -> ของที่มีอยู่ตอนนี้ถือว่าถูกต้อง ตรวจแค่ส่วนที่โตขึ้นหลังจากนี้");
      if (!dry) {
        await store.del(progKey(u));          // ทิ้งเส้นฐาน/โควตาเดิมทั้งชุด
        await rememberProgress(u, prog, Date.now());
      }
    }
  }

  if (!did.length) return { ok: false, msg: "ไม่ได้เลือกอะไรให้ล้าง" };
  return {
    ok: true, user: acct.user || u, dry_run: dry, did, warn,
    bans: await listBans(),
    note: dry ? "นี่คือการดูก่อนเท่านั้น ยังไม่ได้แก้อะไร" : "เสร็จแล้ว — ถ้าเจ้าตัวค้างอยู่ในเกม ให้ออกแล้วล็อกอินใหม่",
  };
}
