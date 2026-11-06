// lib/builds.js -- v80.72: ดู "บิลด์" ของผู้เล่น เพื่อเอาไว้ศึกษาบาลานซ์
//
// เจ้าของเกมอยากรู้ 3 อย่าง: ใครใส่ไอเทมอะไร / เล่นคลาสอะไร / ลงโหนดไหน
// ไฟล์นี้ทำสองหน้าที่
//   1) buildOf(c)      -> สรุปบิลด์ของตัวละคร 1 ตัว (คลาส + โหนด + ของที่สวม + แต้ม)
//   2) buildStats(...) -> รวมทุกคนเป็นสถิติ: คลาสไหนคนเล่นเยอะ โหนดไหนคนลงบ่อย ของชิ้นไหนฮิต
//
// ชื่อสาย/ชื่อโหนดมาจาก lib/game_meta.json ซึ่งสร้างด้วย tools/gen_admin_meta.py
// (หลังบ้านดีพลอยแยกจากตัวเกม อ่าน data/ ของเกมตรงๆ ไม่ได้)
import META from "./game_meta.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** ช่องสวมใส่ -> ชื่อไทย (เรียงตามลำดับที่อยากให้โชว์) */
export const SLOT_NAMES = {
  main: "มือหลัก", off: "มือรอง", helm: "หมวก", chest: "ชุดเกราะ",
  gloves: "ถุงมือ", belt: "เข็มขัด", boots: "รองเท้า",
  amulet: "สร้อยคอ", ring1: "แหวนซ้าย", ring2: "แหวนขวา",
};
const SLOT_ORDER = Object.keys(SLOT_NAMES);

export const RARITY_NAMES = {
  normal: "ธรรมดา", magic: "เวท", rare: "หายาก", unique: "ยูนิค", rainbow: "สายรุ้ง",
};

export function tribeName(id) {
  const t = META.tribes[String(id || "")];
  if (!t) return String(id || "");
  return t.th ? `${t.name} (${t.th})` : t.name;
}

export function tribeNodeName(tribe, nodeId) {
  const t = META.tribes[String(tribe || "")];
  const n = t && t.nodes ? t.nodes[String(nodeId)] : null;
  return n && n.n ? n.n : String(nodeId);
}

export function passiveName(nodeId) {
  const n = META.passives[String(nodeId)];
  return n && n.n ? n.n : "";
}

function isNotable(tribe, nodeId) {
  const t = META.tribes[String(tribe || "")];
  const n = t && t.nodes ? t.nodes[String(nodeId)] : null;
  return !!(n && n.k === "notable");
}

/** ออฟชั่นของไอเทมแบบย่อ (ไว้ดูว่าบิลด์นี้ได้ค่าอะไรมาจากของ) */
function statLine(it) {
  const st = it && it.stats && typeof it.stats === "object" ? it.stats : {};
  return Object.entries(st)
    .map(([k, v]) => `${k} ${num(v) >= 0 ? "+" : ""}${Math.round(num(v) * 10) / 10}`)
    .join(" · ");
}

function itemBrief(it, slot) {
  return {
    slot,
    slot_name: SLOT_NAMES[slot] || slot,
    id: String(it.id || ""),
    name: String(it.name || it.id || "?"),
    rarity: String(it.rarity || "normal"),
    rarity_name: RARITY_NAMES[String(it.rarity || "normal")] || String(it.rarity || ""),
    req_level: num(it.req_level || it.level),
    stats: statLine(it),
    affixes: it.stats && typeof it.stats === "object" ? Object.keys(it.stats).length : 0,
    uid: String(it.uid || ""),
  };
}

/** สรุปบิลด์ของตัวละครหนึ่งตัว */
export function buildOf(c) {
  if (!c || typeof c !== "object") return null;
  const inv = c.inventory && typeof c.inventory === "object" ? c.inventory : {};
  const eq = inv.equipment && typeof inv.equipment === "object" ? inv.equipment : {};
  const equipment = [];
  for (const slot of SLOT_ORDER) {
    const it = eq[slot];
    if (it && typeof it === "object" && Object.keys(it).length) equipment.push(itemBrief(it, slot));
  }
  // ช่องที่ไม่รู้จัก (เผื่อเกมเพิ่มช่องใหม่แล้วลืมมาอัปเดตตาราง)
  for (const [slot, it] of Object.entries(eq)) {
    if (SLOT_ORDER.includes(slot)) continue;
    if (it && typeof it === "object" && Object.keys(it).length) equipment.push(itemBrief(it, slot));
  }

  const tb = c.tribes && typeof c.tribes === "object" ? c.tribes : {};
  const tribe = String(tb.tribe || "");
  const nodeIds = tb.nodes && typeof tb.nodes === "object" ? Object.keys(tb.nodes) : [];
  nodeIds.sort();
  const asc_nodes = nodeIds.map((id) => ({
    id, name: tribeNodeName(tribe, id), notable: isNotable(tribe, id),
  }));

  const pt = Array.isArray(c.passive_tree) ? c.passive_tree.map(String) : [];
  const notables = pt.filter((id) => (META.passives[id] || {}).k === "notable")
    .map((id) => ({ id, name: passiveName(id), branch: (META.passives[id] || {}).b || "" }));
  const branch_count = {};
  for (const id of pt) {
    const b = (META.passives[id] || {}).b || "?";
    branch_count[b] = (branch_count[b] || 0) + 1;
  }

  const rn = c.runes && typeof c.runes === "object" ? c.runes : {};
  const flasks = inv.flasks && typeof inv.flasks === "object" ? inv.flasks : {};

  return {
    name: String(c.name || "?"),
    level: num(c.level) || 1,
    tribe,
    tribe_name: tribe ? tribeName(tribe) : "ยังไม่เลือกสาย",
    tribe_points_left: num(tb.points),
    tiers: tb.tiers && typeof tb.tiers === "object" ? Object.keys(tb.tiers).map(num).sort((a, b) => a - b) : [],
    asc_nodes,
    asc_notables: asc_nodes.filter((n) => n.notable).map((n) => n.name),
    passive_count: pt.length,
    passive_notables: notables,
    passive_branches: branch_count,
    alloc: c.alloc && typeof c.alloc === "object" ? c.alloc : {},
    equipment,
    empty_slots: SLOT_ORDER.filter((s) => !equipment.some((e) => e.slot === s)).map((s) => SLOT_NAMES[s]),
    flasks: Object.values(flasks).filter((f) => f && Object.keys(f).length).map((f) => String(f.name || f.id || "?")),
    runes_placed: Array.isArray(rn.placed) ? rn.placed.length : 0,
    runes_bag: Array.isArray(rn.bag) ? rn.bag.length : 0,
    gold: num(inv.gold),
  };
}

const top = (map, n) => Object.entries(map).sort((a, b) => b[1].count - a[1].count).slice(0, n).map(([, v]) => v);

/**
 * รวมบิลด์ของทุกคนเป็นสถิติสำหรับดูบาลานซ์ (รับตัวละครดิบจากเซฟ)
 * @param chars [{user, char}]
 */
export function buildStats(chars, minLevel = 10) {
  return statsFromBuilds(chars.map((r) => ({ user: r.user, build: buildOf(r.char) })), minLevel);
}

/**
 * เวอร์ชันที่รับบิลด์ที่สรุปไว้แล้ว (หน้าหลังบ้านแคชบิลด์ไว้ตั้งแต่ตอนโหลดบัญชี)
 * @param list [{user, build}]
 * @param minLevel นับเฉพาะตัวละครที่เลเวลถึงเกณฑ์ (ตัวที่เพิ่งสร้างยังไม่มีบิลด์ให้ดู)
 */
export function statsFromBuilds(list, minLevel = 10) {
  const builds = [];
  for (const row of list) {
    const b = row && row.build;
    if (!b) continue;
    builds.push({ ...b, user: String(row.user || "") });
  }
  const counted = builds.filter((b) => b.level >= minLevel);

  // ---- คลาสเสริม (สายบรรพชน) ----
  const tribes = {};
  for (const b of counted) {
    const key = b.tribe || "(ยังไม่เลือก)";
    if (!tribes[key]) tribes[key] = { id: key, name: b.tribe ? tribeName(b.tribe) : "ยังไม่เลือกสาย", count: 0, levels: [], picked: 0 };
    tribes[key].count++;
    tribes[key].levels.push(b.level);
  }
  const tribeRows = Object.values(tribes).map((t) => ({
    id: t.id, name: t.name, count: t.count,
    share: counted.length ? Math.round((t.count / counted.length) * 1000) / 10 : 0,
    avg_level: t.levels.length ? Math.round(t.levels.reduce((s, x) => s + x, 0) / t.levels.length) : 0,
  })).sort((a, b) => b.count - a.count);

  // ---- โหนดคลาสเสริม: คนที่เล่นสายนี้ ลงโหนดไหนกี่ % ----
  const ascByTribe = {};
  for (const b of counted) {
    if (!b.tribe) continue;
    if (!ascByTribe[b.tribe]) ascByTribe[b.tribe] = { tribe: b.tribe, name: tribeName(b.tribe), players: 0, nodes: {} };
    const t = ascByTribe[b.tribe];
    t.players++;
    for (const n of b.asc_nodes) {
      if (!t.nodes[n.id]) t.nodes[n.id] = { id: n.id, name: n.name, notable: n.notable, count: 0 };
      t.nodes[n.id].count++;
    }
  }
  const ascRows = Object.values(ascByTribe).map((t) => ({
    tribe: t.tribe, name: t.name, players: t.players,
    nodes: Object.values(t.nodes)
      .map((n) => ({ ...n, pick: Math.round((n.count / t.players) * 1000) / 10 }))
      .sort((a, b) => b.count - a.count),
    // โหนดของสายนี้ที่ "ไม่มีใครลงเลย" = จุดที่น่าสงสัยว่าอ่อนไป
    never: Object.entries((META.tribes[t.tribe] || {}).nodes || {})
      .filter(([id]) => !t.nodes[id])
      .map(([id, n]) => ({ id, name: n.n || id, notable: n.k === "notable" })),
  })).sort((a, b) => b.players - a.players);

  // ---- โหนดเด่นของต้นไม้พรสวรรค์ ----
  const pas = {};
  for (const b of counted) {
    for (const n of b.passive_notables) {
      if (!pas[n.id]) pas[n.id] = { id: n.id, name: n.name, branch: n.branch, count: 0 };
      pas[n.id].count++;
    }
  }
  const passiveRows = Object.values(pas)
    .map((n) => ({ ...n, pick: counted.length ? Math.round((n.count / counted.length) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count);

  // ---- ไอเทมที่ใส่กันเยอะที่สุด (แยกตามช่อง + รวมของยูนิค) ----
  const bySlot = {};
  const uniques = {};
  for (const b of counted) {
    for (const it of b.equipment) {
      if (!bySlot[it.slot]) bySlot[it.slot] = { slot: it.slot, name: SLOT_NAMES[it.slot] || it.slot, worn: 0, items: {} };
      const s = bySlot[it.slot];
      s.worn++;
      const key = it.id || it.name;
      if (!s.items[key]) s.items[key] = { key, name: it.name, rarity: it.rarity, count: 0 };
      s.items[key].count++;
      if (it.rarity === "unique" || it.rarity === "rainbow") {
        if (!uniques[key]) uniques[key] = { key, name: it.name, rarity: it.rarity, slot: it.slot, count: 0 };
        uniques[key].count++;
      }
    }
  }
  const slotRows = SLOT_ORDER.filter((s) => bySlot[s]).map((s) => {
    const row = bySlot[s];
    return {
      slot: s, name: row.name, worn: row.worn,
      worn_pct: counted.length ? Math.round((row.worn / counted.length) * 1000) / 10 : 0,
      top: top(row.items, 5),
    };
  });

  // ---- การแจกแต้มสถานะ (เฉลี่ยต่อสาย) ----
  const attrKeys = ["str", "dex", "int", "luk", "vit"];
  const attrByTribe = {};
  for (const b of counted) {
    const key = b.tribe || "(ยังไม่เลือก)";
    if (!attrByTribe[key]) attrByTribe[key] = { id: key, name: b.tribe ? tribeName(b.tribe) : "ยังไม่เลือกสาย", n: 0, sum: {} };
    const a = attrByTribe[key];
    a.n++;
    for (const k of attrKeys) a.sum[k] = (a.sum[k] || 0) + num(b.alloc[k]);
  }
  const attrRows = Object.values(attrByTribe).map((a) => ({
    id: a.id, name: a.name, n: a.n,
    avg: Object.fromEntries(attrKeys.map((k) => [k, Math.round((a.sum[k] || 0) / a.n)])),
  })).sort((a, b) => b.n - a.n);

  return {
    total_characters: builds.length,
    counted: counted.length,
    min_level: minLevel,
    tribes: tribeRows,
    ascendancy: ascRows,
    passives: passiveRows.slice(0, 40),
    slots: slotRows,
    uniques: Object.values(uniques).sort((a, b) => b.count - a.count).slice(0, 25),
    attributes: attrRows,
    // รายตัว เรียงเลเวลมากไปน้อย — เอาไว้ไล่ดูบิลด์คนเก่งๆ
    top_builds: counted.slice().sort((a, b) => b.level - a.level).slice(0, 30).map((b) => ({
      user: b.user, name: b.name, level: b.level, tribe_name: b.tribe_name,
      asc: b.asc_nodes.length, passives: b.passive_count,
      notables: b.asc_notables, equipped: b.equipment.length,
    })),
  };
}
