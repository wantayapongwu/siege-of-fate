// lib/anticheat.js -- v78.4: ตรวจ "ความเป็นไปได้" ของเซฟก่อนรับเข้าเซิร์ฟเวอร์
//
// ที่มา: เกมนี้คิดทุกอย่างในเครื่องผู้เล่น (client-authoritative) แล้วส่ง "ก้อนเซฟ" ขึ้นมาเก็บ
//        เดิมเซิร์ฟเวอร์รับทุกอย่างที่ส่งมาโดยไม่ตรวจเลย -> ใครก็ได้ที่สมัครบัญชี (ฟรี เปิดให้ทุกคน)
//        ยิง POST /api/save ด้วยเซฟที่เขียนเองได้ เช่น เลเวล 100 + เงินล้าน โดยไม่ต้อง "เจาะ" อะไรเลย
//
// ไฟล์นี้ไม่ได้ทำให้โกงไม่ได้ 100% (ต้องย้ายการคำนวณไปอยู่บนเซิร์ฟเวอร์ถึงจะปิดสนิท)
// แต่ปิดช่องที่ใช้ง่ายที่สุด และทำให้การโกงที่เหลือ "ช้าลงจนไม่คุ้ม" + ตรวจจับได้:
//   1) เพดานตายตัว  — เลเวลเกิน 100 / เงินติดลบ / เงินเกินเพดาน = ปฏิเสธทันที
//   2) อัตราความก้าวหน้า — เทียบกับเซฟก่อนหน้าของบัญชีเดียวกัน เลเวลและเงินโตเร็วเกินจริงไม่ได้
//   3) บันทึกธง — ครั้งที่ถูกปฏิเสธถูกเก็บไว้ให้หน้า /admin เห็น (ใครพยายามโกงบ้าง)
//
// ค่าปรับได้ด้วย env (ไม่ต้องแก้โค้ด): SOF_MAX_LEVEL_PER_HOUR, SOF_MAX_GOLD_PER_HOUR, SOF_GOLD_CAP
import * as store from "./store.js";

export const MAX_LEVEL = 100;
export const FREE_LEVEL = 20;          // เลเวลต้นเกมขึ้นเร็วมากโดยตั้งใจ -> ไม่คิดอัตราในช่วงนี้

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0);

// ======================== v78.8: ผูกความก้าวหน้าเข้ากับ "จำนวนที่ฆ่า" ========================
// ที่มา: คิดจากสูตรจริงในเกม (ดูตารางใน CHANGELOG ของ v78.8)
//   EXP ที่ต้องใช้ = 100 x เลเวล^1.6  -> 1 ถึง 100 รวม 6,016,706 EXP
//   EXP ต่อตัว     = exp ฐาน x (1 + 0.3 x เลเวลมอน) x 2 ถ้ายอดฝีมือ x โบนัสของ x โบนัสปาร์ตี้
//   เงินต่อตัว     = สุ่ม 1..เลเวลมอน x ตัวคูณความโหด x (1 + Gold Find%) x โอกาสดรอป
//
// เพดาน "เป็นไปไม่ได้" คิดจากกรณีเก่งสุดเท่าที่เกมอนุญาต:
//   EXP : exp ฐานสูงสุด 60 x (1+0.3x85) x 2 (ยอดฝีมือ) x 2 (ของ +100%) x 1.7 (ปาร์ตี้ 8 คน) = 10,812
//   เงิน : เลเวลมอน 85 x ตัวคูณบอส 25 x Gold Find x4 = 8,500
// เผื่อไว้อีกเท่าตัวกันพลาดใส่คนเล่นจริง
export const EXP_PER_KILL_MAX = 12_000;    // ปฏิเสธถ้าเกิน
export const EXP_PER_KILL_SANE = 1_500;    // ติดธงถ้าเกิน (เล่นปกติอยู่แถว 300-800)
// v79.0: บอสให้ EXP ก้อนใหญ่กว่ามอนธรรมดาหลายสิบเท่า -> ต้องมีโควตาของตัวเอง
//   ราชาโครงกระดูก exp ฐาน 1,200 ที่เลเวล 85 = 1,200 x (1+0.3x85) = 31,800 ต่อตัว
//   กรณีเก่งสุด: 31,800 x 2 (ยอดฝีมือ) x 2 (ของ +100%) x 1.7 (ปาร์ตี้ 8 คน) = 216,240
// ที่มา: คนรีดันเจี้ยนฆ่าเฉพาะบอสวันละ 200 ครั้งเป็นเรื่องปกติของเกมนี้
//   ถ้าคิดด้วยเพดานมอนธรรมดา (12,000/ตัว) จะกลายเป็น "ได้ EXP 6.36 ล้าน จากการฆ่า 200 ตัว" = โดนแบนฟรี
export const BOSS_EXP_PER_KILL_MAX = 250_000;    // ปฏิเสธถ้าเกิน
export const BOSS_EXP_PER_KILL_SANE = 120_000;   // ติดธงถ้าเกิน

// ======================== v79.1: เลเวลที่ได้มา ต้องมาจากมอนที่ฆ่าได้จริง ========================
// ที่มา: กฎ 3 เทียบแค่ "EXP ที่เพิ่ม ≤ จำนวนที่ฆ่า x เพดาน" โดยไม่รู้ว่าฆ่ามอนเลเวลเท่าไหร่
//        -> เซฟที่บอกว่า "ฟาร์มสุสานชั้น 1 (มอนเลเวล 5) จนเลเวล 80" ยังผ่าน ซึ่งในเกมทำไม่ได้เลย
//        เพราะ EXP ถูกตัดทอนตามส่วนต่างเลเวล (CharacterStats.exp_level_mult)
//        เลเวล 20 ฆ่ามอนเลเวล 5 ได้ EXP 1.42% | เลเวล 30 ได้ 0.22% | เลเวล 80 ได้ 0.011%
// ตอนนี้: เกมส่ง "ฆ่ามอนเลเวลไหนไปกี่ตัว" ขึ้นมา (exp_kills_lv) แล้วเซิร์ฟเวอร์ไล่สูตรเดียวกับในเกม
//        ว่าด้วยมอนชุดนั้น ไปถึงเลเวลสูงสุดได้เท่าไหร่ -> เลเวลในเซฟเกินกว่านั้นไม่ได้
// ค่าทุกตัวตั้งแบบ "ใจกว้างสุด" เพื่อไม่ให้ไปโดนคนเล่นจริง:
//   เลเวลมอนที่ให้ EXP ดิบสูงสุดต่อตัว: มอนทั่วไป 60 (ลูกมังกร) | บอส 1,200 (ราชาโครงกระดูก)
//   โบนัสคูณสูงสุด: x2 (มอนอีลีท) x3 (ของ +200% EXP) x1.7 (ปาร์ตี้ 8 คน) x1.2 (ดันเจี้ยนกลางคืน)
// ของจริงคนเล่นได้ราว x1-2 เท่านั้น -> เพดานนี้กว้างกว่าความจริงหลายเท่า
export const TRASH_BASE_MAX = 60;
export const BOSS_BASE_MAX = 1_200;
export const BONUS_MAX = 2 * 3 * 1.7 * 1.2;      // = 12.24
export const QUEST_EXP_MAX = 2_000;              // EXP จากเควสทั้งเกมรวมกัน 900 -> เผื่อไว้เท่าตัว
export const EXP_ZERO_DIFF = 30;                 // v79.2: ห่างกว่านี้ = ไม่ได้ EXP เลย (ตรงกับในเกม)

// ======================== v79.7: แต้มสถานะ/ต้นไม้/โหนดเผ่า ต้องไม่เกินที่เลเวลนี้มีสิทธิ์ ========================
// ที่มา: ด่านเดิมตรวจเลเวล เงิน และไอเทม แต่ไม่เคยตรวจ "แต้มที่ลงไว้"
//   -> แก้ไฟล์เซฟใส่ alloc.str = 1,000,000 ได้เลย = พลังโจมตีและเลือดเป็นล้าน โดยเลเวลยังดูปกติ
// ค่าทั้งหมดตรงกับสูตรในเกม (CharacterStats / Tribes) — ถ้าปรับบาลานซ์ต้องแก้ทั้งสองที่
export const ATTR_START = 5;            // CharacterStats.START_ATTR_POINTS
export const ATTR_PER_LEVEL = 5;        // CharacterStats.ATTR_POINTS_PER_LEVEL
export const PASSIVE_START = 1;         // CharacterStats.START_PASSIVE_POINTS
export const TRIBE_TIERS = 4;           // Tribes.TIERS
export const TRIBE_POINTS_PER_TIER = 2; // Tribes.POINTS_PER_TIER
export const MAX_RUNES_PLACED = 60;     // กระดานรูนมีขนาดจำกัดอยู่แล้ว — เผื่อไว้กว้างๆ
export const MAX_RUNES_BAG = 300;

const allocSum = (a) => {
  if (!a || typeof a !== "object") return 0;
  let t = 0;
  for (const v of Object.values(a)) t += Math.max(0, num(v));
  return t;
};

/**
 * แต้มที่ลงไว้เกินสิทธิ์ไหม (คิดจากเลเวลของตัวละครนั้นเอง)
 * เป็นกฎแบบ "เป็นไปไม่ได้" -> นับเข้าแบนอัตโนมัติ เพราะไม่มีทางเกิดจากการเล่นปกติ
 */
export function statFaults(save) {
  const bad = [];
  for (const c of charsOfSave(save)) {
    const name = String(c.name || "?");
    const lv = Math.max(1, Math.min(MAX_LEVEL, num(c.level) || 1));

    const spent = allocSum(c.alloc);
    const attrMax = ATTR_START + (lv - 1) * ATTR_PER_LEVEL;
    if (spent > attrMax)
      bad.push(`${name}: ลงแต้มสถานะ ${spent.toLocaleString()} แต้ม แต่เลเวล ${lv} มีได้แค่ ${attrMax}`);
    for (const [k, v] of Object.entries(c.alloc || {})) {
      if (num(v) < 0) bad.push(`${name}: แต้ม ${k} ติดลบ (${num(v)})`);
    }

    const tree = Array.isArray(c.passive_tree) ? c.passive_tree.length : 0;
    const treeMax = PASSIVE_START + (lv - 1);
    if (tree > treeMax)
      bad.push(`${name}: ลงแต้มต้นไม้ ${tree} จุด แต่เลเวล ${lv} มีได้แค่ ${treeMax}`);

    const tb = c.tribes && typeof c.tribes === "object" ? c.tribes : null;
    if (tb) {
      const tiers = tb.tiers && typeof tb.tiers === "object" ? Object.keys(tb.tiers) : [];
      const okTiers = tiers.filter((t) => num(t) >= 1 && num(t) <= TRIBE_TIERS).length;
      if (tiers.length > TRIBE_TIERS)
        bad.push(`${name}: ผ่านบททดสอบเผ่า ${tiers.length} ระดับ (มีจริงแค่ ${TRIBE_TIERS})`);
      const nodes = tb.nodes && typeof tb.nodes === "object" ? Object.keys(tb.nodes).length : 0;
      // ทุกโหนดมีราคาอย่างน้อย 1 แต้ม -> จำนวนโหนดต้องไม่เกินแต้มทั้งหมดที่หาได้
      const nodeMax = okTiers * TRIBE_POINTS_PER_TIER;
      if (nodes > nodeMax)
        bad.push(`${name}: เปิดโหนดเผ่า ${nodes} โหนด แต่แต้มที่หาได้มีแค่ ${nodeMax}`);
    }

    const rn = c.runes && typeof c.runes === "object" ? c.runes : null;
    if (rn) {
      const placed = Array.isArray(rn.placed) ? rn.placed.length : 0;
      const bagN = Array.isArray(rn.bag) ? rn.bag.length : 0;
      if (placed > MAX_RUNES_PLACED) bad.push(`${name}: รูนบนกระดาน ${placed} ชิ้น (เพดาน ${MAX_RUNES_PLACED})`);
      if (bagN > MAX_RUNES_BAG) bad.push(`${name}: รูนในถุง ${bagN} ชิ้น (เพดาน ${MAX_RUNES_BAG})`);
    }
    if (bad.length > 20) break;
  }
  return bad;
}
export const HIST_COVER = 0.9;                   // ประวัติต้องครอบคลุมการฆ่าเท่านี้ขึ้นไปถึงจะเอามาตัดสิน

// ======================== v79.8: ล็อกปลายสาย — "ฆ่ามอน" ต้องผูกกับเวลาเล่นจริง ========================
// สายโซ่ที่ต้องการ: แต้ม <- เลเวล <- EXP <- จำนวนที่ฆ่า <- เวลาเล่นจริง
//   สามข้อแรกปิดแล้ว (v79.7 / v79.1 / v79.5) แต่ข้อสุดท้ายยังว่าง
//   -> เคลมว่า "ฆ่าไปแล้ว 10 ล้านตัว" ได้ฟรี แล้วทุกกฎที่อ้างอิงจำนวนที่ฆ่าก็เปิดให้หมด
// เพดานคิดจากของจริงในเกม: สุสานชั้น 1 มีมอน 127 ตัว เคลียร์เร็วสุดราว 78 วินาที = ~5,900 ตัว/ชม.
//   ตั้งไว้ 10,000 ตัวต่อหนึ่ง "ช่วงชั่วโมงที่เล่นจริง" (ph) = เผื่อไว้เกือบสองเท่าของคนฟาร์มหนักสุด
export const KILLS_PER_PLAY_HOUR = 10_000;
// เลเวลมอนที่ให้ EXP มากสุดสำหรับผู้เล่นเลเวลนี้ (ในเขตปลอดภัย ยิ่งเลเวลมอนสูงยิ่งได้มาก)
// ใช้เติมแทน "การฆ่าที่ไม่มีประวัติ" แบบใจกว้างที่สุด — ตัวละครรุ่นเก่าจึงไม่ถูกตัดสินผิด
export const DEEPEST_MONSTER_LEVEL = 85;
export function bestMonsterLevelFor(playerLevel) {
  const pl = Math.max(1, num(playerLevel));
  return Math.min(DEEPEST_MONSTER_LEVEL, pl + Math.floor(3 + pl / 16));
}

export function killsPerPlayHour() {
  const n = Number(process.env.SOF_MAX_KILLS_PER_HOUR);
  return Number.isFinite(n) && n >= 100 ? Math.floor(n) : KILLS_PER_PLAY_HOUR;
}

/**
 * จำนวนที่ฆ่าสะสม ต้องไม่เกินที่เวลาเล่นจริงจะพาไปได้
 * ตรวจกับ "ยอดสะสมทั้งบัญชี" ไม่ใช่ส่วนต่างต่อครั้ง -> แยกส่งเป็นหลายก้อนก็เลี่ยงไม่ได้
 */
export function killRateFaults(prog, prev) {
  const bad = [];
  if (!prev) return bad;
  // v79.8: ผู้เล่นเก่าที่ฆ่าสะสมมาก่อนกฎนี้มีผล -> ใช้ยอดตอนนั้นเป็น "เส้นฐาน"
  //        แล้วคุมเฉพาะส่วนที่เพิ่มขึ้นหลังจากนั้น (ไม่ย้อนไปตัดสินของเก่า)
  const base = num(prev.kills0);
  const ph = Math.max(1, num(prev.ph));
  const cap = killsPerPlayHour() * ph + FIRST_KILLS_MAX;
  const grew = prog.kills - base;
  if (grew > cap)
    bad.push(`ฆ่าสะสมเพิ่มขึ้น ${Math.round(grew).toLocaleString()} ตัว แต่เล่นจริงมาแค่ ${ph} ช่วงชั่วโมง (เพดาน ${cap.toLocaleString()})`);
  return bad;
}

// ======================== v79.5: โควตาต้องเป็น "ต่อเวลา" ไม่ใช่ "ต่อคำขอ" ========================
// รูที่เจอ (พิสูจน์แล้ว): เดิมทุกคำขอได้โควตาฟรี (FIRST_KILLS_MAX x เพดานต่อตัว = 720,000 EXP
//   และ TRADE_GOLD_BURST = 500,000 เงิน) -> ยิง /api/save ไต่ทีละก้าว 96 ครั้ง
//   ได้เลเวล 100 + เงิน 28.5 ล้าน โดยไม่ฆ่ามอนแม้แต่ตัวเดียว และไม่ติดธงเลย
// แก้: โควตาฟรีกลายเป็น "ถังที่ใช้แล้วหมด" เก็บยอดที่ใช้ไปในระเบียนความก้าวหน้า
//   - EXP : โควตานอกเหนือจากการฆ่า มีให้ทั้งชีวิตบัญชี GRACE_EXP_TOTAL (เผื่อ EXP เควส/เศษปัดเศษ)
//   - เงิน: ถังเติมตามเวลา TRADE_GOLD_PER_HOUR ต่อชั่วโมง เพดานถัง TRADE_GOLD_BURST (token bucket)
export const GRACE_EXP_TOTAL = 50_000;     // EXP เควสทั้งเกมรวม 900 -> เผื่อไว้มากกว่า 50 เท่า
export const GRACE_GOLD_TOTAL = 20_000;    // เงินเริ่มต้น/ของขวัญ/เศษ
export const LEVEL_SLACK = 2;                    // เผื่อให้อีก 2 เลเวล

/** สูตรตัดทอน EXP ตามส่วนต่างเลเวล — ต้องตรงกับ CharacterStats.exp_level_mult ในเกม */
export function expLevelMult(playerLevel, monsterLevel) {
  if (!(monsterLevel > 0)) return 1;
  const pl = Math.max(num(playerLevel), 1);
  if (Math.abs(pl - num(monsterLevel)) > EXP_ZERO_DIFF) return 0;   // v79.2
  const safe = Math.floor(3 + pl / 16);
  const diff = Math.max(Math.abs(pl - num(monsterLevel)) - safe, 0);
  let m = Math.pow(pl + 5, 1.5) / Math.pow(pl + 5 + Math.pow(diff, 2.5), 1.5);
  if (pl > 95) m /= 1 + 0.1 * (pl - 94);
  return Math.min(Math.max(m, 0), 1);
}

/** EXP ดิบสูงสุดที่มอนเลเวลนี้ให้ได้ (ก่อนตัดทอนตามส่วนต่างเลเวล) */
export function killCap(monsterLevel, boss = false) {
  return (boss ? BOSS_BASE_MAX : TRASH_BASE_MAX) * (1 + 0.3 * Math.max(num(monsterLevel), 0)) * BONUS_MAX;
}

/** EXP ที่ต้องใช้เพื่อขึ้นจากเลเวลนี้ไปเลเวลถัดไป (ตรงกับ CharacterStats.exp_to_next) */
const expToNext = (L) => Math.round(100 * Math.pow(L, 1.6));

/**
 * ด้วยมอนชุดนี้ ไปถึงเลเวลสูงสุดได้เท่าไหร่
 * @param buckets [{level, n, boss}]  ฆ่ามอนเลเวลนั้นไปกี่ตัว
 * @param bonusExp  EXP จากทางอื่น (เควส) ที่ยกให้ฟรี
 *
 * ไล่จากเลเวล 1 ขึ้นไป แต่ละรอบเลือกมอนที่ "ให้ EXP ต่อตัวมากที่สุดที่เลเวลนี้" มาใช้ก่อน
 * = ใช้มอนในลำดับที่ได้เลเวลสูงสุดเท่าที่เป็นไปได้ (ใจกว้างกับผู้เล่น)
 * ในเกมฆ่าได้อย่างน้อย 1 EXP ต่อตัวแม้ห่างมาก -> ที่นี่ก็ให้ขั้นต่ำ 1 เหมือนกัน
 */
/**
 * @param wildcard จำนวนการฆ่าที่ "ไม่รู้ว่าเป็นมอนเลเวลไหน" (เซฟรุ่นเก่าที่ยังไม่มีประวัติ)
 *   คิดแบบใจกว้างที่สุด: ที่เลเวลไหนก็ให้ EXP เท่ากับมอนที่ดีที่สุดสำหรับเลเวลนั้น
 *   (เติมเป็นก้อนเดียวที่เลเวลสูงสุดไม่ได้ เพราะตอนเลเวล 1 มอนเลเวล 85 ให้ 0 ตามกฎ v79.2)
 */
export function maxLevelFrom(buckets, bonusExp = QUEST_EXP_MAX, wildcard = 0) {
  const left = (buckets || [])
    .map((b) => ({ m: Math.max(num(b.level), 0), n: Math.max(num(b.n), 0), c: killCap(b.level, b.boss) }))
    .filter((b) => b.n > 0);
  let L = 1, pool = Math.max(0, num(bonusExp)), guard = 0;
  while (L < MAX_LEVEL && pool >= expToNext(L)) { pool -= expToNext(L); L++; }
  let wild = Math.max(0, num(wildcard));
  while (L < MAX_LEVEL && guard++ < 10_000) {
    let bi = -1, by = 0;   // by = EXP ต่อตัวที่ดีที่สุดที่เลเวลนี้ (0 = ใช้มอนที่เหลือไม่ได้แล้ว)
    for (let i = 0; i < left.length; i++) {
      if (left[i].n <= 0) continue;
      const mu = expLevelMult(L, left[i].m);
      const y = mu > 0 ? Math.max(1, left[i].c * mu) : 0;   // v79.2: ห่างเกิน 30 เลเวล = 0 ไม่ใช่ 1
      if (y > by) { by = y; bi = i; }
    }
    // การฆ่าที่ไม่รู้เลเวลมอน: ให้ค่าเท่ากับมอนที่ดีที่สุดของเลเวลปัจจุบัน
    const wy = wild > 0 ? killCap(bestMonsterLevelFor(L), false) : 0;
    if (wy > by) {
      const needW = expToNext(L) - pool;
      const kw = Math.min(wild, Math.max(1, Math.ceil(needW / wy)));
      pool += kw * wy;
      wild -= kw;
      while (L < MAX_LEVEL && pool >= expToNext(L)) { pool -= expToNext(L); L++; }
      continue;
    }
    if (bi < 0) break;
    const need = expToNext(L) - pool;
    const k = Math.min(left[bi].n, Math.max(1, Math.ceil(need / by)));
    pool += k * by;
    left[bi].n -= k;
    while (L < MAX_LEVEL && pool >= expToNext(L)) { pool -= expToNext(L); L++; }
  }
  return L;
}

/** ประวัติเลเวลมอนของตัวละครหนึ่งตัว -> buckets (รวมบอสจาก boss_kills ซึ่งรู้เลเวลแน่นอน) */
export function bucketsOfChar(c) {
  const out = [];
  const hist = c && typeof c.exp_kills_lv === "object" && c.exp_kills_lv ? c.exp_kills_lv : {};
  const bossAt = {};
  for (const [key, n] of Object.entries((c && c.boss_kills) || {})) {
    const lv = Number(String(key).split("@")[1]);
    if (Number.isFinite(lv)) bossAt[lv] = (bossAt[lv] || 0) + Math.max(0, num(n));
  }
  let total = 0;
  const usedBoss = {};
  for (const [lv, n] of Object.entries(hist)) {
    const level = Number(lv);
    const cnt = Math.max(0, num(n));
    if (!Number.isFinite(level) || cnt <= 0) continue;
    total += cnt;
    // ตัวที่เป็นบอสในเลเวลนั้นได้เพดานของบอส ที่เหลือได้เพดานมอนทั่วไป
    const nb = Math.min(cnt, bossAt[level] || 0);
    if (nb > 0) { out.push({ level, n: nb, boss: true }); usedBoss[level] = nb; }
    if (cnt - nb > 0) out.push({ level, n: cnt - nb, boss: false });
  }
  // v79.8: บอสที่ล้มได้แต่ไม่ปรากฏในประวัติ (เซฟรุ่นก่อนมีประวัติ) -> นับเป็นถังของตัวเอง
  //        boss_kills บอกเลเวลบอสแน่นอนอยู่แล้ว จึงใช้ได้โดยไม่ต้องเดา
  for (const [lv, n] of Object.entries(bossAt)) {
    const extra = Math.max(0, num(n) - (usedBoss[lv] || 0));
    if (extra > 0) { out.push({ level: Number(lv), n: extra, boss: true }); total += extra; }
  }
  return { buckets: out, total };
}

/**
 * เลเวลในเซฟเป็นไปได้ไหม เทียบกับมอนที่ฆ่ามา
 * ใช้ตัดสินเฉพาะตัวละครที่ประวัติครอบคลุมการฆ่าเกือบทั้งหมด (ตัวละครเก่าที่ยังไม่มีประวัติ -> ข้าม)
 */
export function historyFaults(prog, prev = null) {
  const bad = [];
  // v79.5: "เคยส่งประวัติเลเวลมอนแล้ว" -> ครั้งต่อไปจะเลิกส่งไม่ได้ (เลิกส่ง = เซฟที่เขียนเอง)
  //        ตัวละครเก่าที่ยังไม่เคยส่งเลยยังข้ามได้ตามเดิม จึงไม่แบนย้อนหลัง
  const seen = !!(prev && Number(prev.hist_seen));
  const strict = seen || String(process.env.SOF_REQUIRE_KILL_LEVELS || "") === "1";
  for (const [name, p] of Object.entries(prog.per)) {
    // ประวัติต้องสอดคล้องกับตัวนับการฆ่าเสมอ (เคลมประวัติเยอะเพื่อขอโควตาเลเวลไม่ได้)
    if (p.hist_total > 0 && p.kills > 0 && p.hist_total > p.kills * 1.05 + 10)
      bad.push(`${name}: ประวัติบอกว่าฆ่า ${p.hist_total} ตัว แต่ตัวนับบอก ${p.kills} ตัว`);
    if (p.level <= FIRST_LEVEL_MAX) continue;
    // ไม่มีข้อมูลการฆ่าเลย (เซฟรุ่นเก่าก่อนมีตัวนับ) -> ไม่มีอะไรให้ตัดสิน ปล่อยให้กฎ EXP จัดการ
    // (กฎ 3 ปฏิเสธ "EXP เพิ่มโดยไม่มีการฆ่า" อยู่แล้ว จึงไม่ใช่ทางหนี)
    if (p.hist_total <= 0 && p.kills <= 0) {
      if (strict) bad.push(`${name}: เลเวล ${p.level} แต่ไม่มีประวัติว่าฆ่ามอนเลเวลไหนมา`);
      continue;
    }
    if (p.hist_total <= 0 && strict) {
      bad.push(`${name}: เลเวล ${p.level} แต่ไม่มีประวัติว่าฆ่ามอนเลเวลไหนมา`);
      continue;
    }
    // v79.8: เดิมถ้าประวัติไม่ครบ 90% ของที่ฆ่า จะ "ข้ามไม่ตัดสิน" -> กลายเป็นทางหนี
    //   (เคลม kills เยอะ ส่งประวัติน้อยๆ แล้วกฎเลเวลก็ไม่ทำงาน)
    //   ตอนนี้ไม่ข้ามแล้ว แต่เติมส่วนที่ไม่มีประวัติด้วย "มอนที่ให้ EXP มากสุดเท่าที่เป็นไปได้"
    //   = ใจกว้างที่สุดเท่าที่กฎยังมีความหมาย ตัวละครรุ่นเก่าจึงไม่ถูกตัดสินผิด
    //   ส่วนการเคลม kills เยอะๆ ถูกปิดด้วย killRateFaults แล้ว
    const missing = Math.max(0, p.kills - p.hist_total);
    const reach = maxLevelFrom(p.buckets, QUEST_EXP_MAX, missing);
    if (p.level > reach + LEVEL_SLACK)
      bad.push(`${name}: เลเวล ${p.level} แต่มอนที่ฆ่ามาทั้งหมดพาไปได้สูงสุดเลเวล ${reach}`);
  }
  return bad;
}
export const GOLD_PER_KILL_MAX = 10_000;   // ปฏิเสธถ้าเกิน
export const GOLD_PER_KILL_SANE = 200;     // ติดธงถ้าเกิน
// เงินจากการเทรด/ตลาดประมูลผูกกับการฆ่าไม่ได้ -> เผื่อโควตาไว้ต่างหาก
export const TRADE_GOLD_PER_HOUR = 300_000;
export const TRADE_GOLD_BURST = 500_000;
// เซฟแรกของบัญชีใหม่ต้องเป็นตัวละครใหม่จริงๆ
export const FIRST_LEVEL_MAX = 5;
export const FIRST_GOLD_MAX = 5_000;
export const FIRST_KILLS_MAX = 60;

export function limits() {
  return {
    goldPerHour: Math.max(1000, num(process.env.SOF_MAX_GOLD_PER_HOUR) || 3_000_000),
    goldCap: Math.max(1_000_000, num(process.env.SOF_GOLD_CAP) || 1_000_000_000),
    expPerKill: Math.max(100, num(process.env.SOF_MAX_EXP_PER_KILL) || EXP_PER_KILL_MAX),
    bossExpPerKill: Math.max(1000, num(process.env.SOF_MAX_BOSS_EXP_PER_KILL) || BOSS_EXP_PER_KILL_MAX),
    goldPerKill: Math.max(10, num(process.env.SOF_MAX_GOLD_PER_KILL) || GOLD_PER_KILL_MAX),
  };
}

// EXP สะสมทั้งหมดของเลเวลนี้ (ตรงกับ CharacterStats.exp_to_next: 100 x level^1.6)
export function totalExpOf(level, expPoints = 0) {
  let t = 0;
  for (let L = 1; L < Math.max(1, Math.min(MAX_LEVEL, level)); L++) t += Math.round(100 * Math.pow(L, 1.6));
  return t + Math.max(0, num(expPoints));
}

/** รวมค่าในตาราง {"<ชนิด>@<เลเวล>": จำนวน} -> จำนวนรวม */
function sumOf(obj) {
  if (!obj || typeof obj !== "object") return 0;
  let t = 0;
  for (const v of Object.values(obj)) t += Math.max(0, num(v));
  return t;
}

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

/** ตัวละครทั้งหมดในก้อนเซฟ (ไฟล์ characters_*.json) */
export function charsOfSave(save) {
  const out = [];
  if (!save || !save.files || typeof save.files !== "object") return out;
  for (const [name, text] of Object.entries(save.files)) {
    if (!name.startsWith("characters_")) continue;
    const list = parse(text);
    if (Array.isArray(list)) for (const c of list) if (c && typeof c === "object" && c.name) out.push(c);
  }
  return out;
}

/** สรุปความก้าวหน้าของบัญชี: เลเวลสูงสุด + เงินรวม + เลเวลรายตัวละคร */
export function progressOf(save) {
  const chars = charsOfSave(save);
  const per = {};
  let maxLevel = 0, gold = 0, exp = 0, kills = 0, bosses = 0;
  for (const c of chars) {
    const lv = num(c.level) || 1;
    const g = num((c.inventory || {}).gold);
    // v78.8: exp_kills = ครั้งที่ได้ EXP จากการฆ่า (รวมตัวที่เพื่อนในปาร์ตี้ฆ่า) | kills = ที่ลงดาบสุดท้ายเอง
    const ek = Math.max(num(c.exp_kills), num(c.kills));
    // v79.0: ครั้งที่ EXP ก้อนนั้นมาจากบอส -> boss_exp_kills (รวมที่เพื่อนลงดาบสุดท้าย)
    //        boss_kills เป็นสถิติ "ตัวเราล้มเอง" ใช้เป็นขั้นต่ำเผื่อเซฟเก่าที่ยังไม่มีตัวนับใหม่
    // โควตาบอสต้องไม่เกินจำนวนที่ฆ่าทั้งหมด (ไม่งั้นเคลม boss_exp_kills สูงลิ่วเพื่อขอโควตาได้)
    const bek = Math.min(ek, Math.max(num(c.boss_exp_kills), sumOf(c.boss_kills)));
    const te = totalExpOf(lv, c.exp);
    const bk = bucketsOfChar(c);
    per[String(c.name)] = { level: lv, gold: g, kills: ek, bosses: bek, exp: te,
      buckets: bk.buckets, hist_total: bk.total };
    if (lv > maxLevel) maxLevel = lv;
    gold += g;
    exp += te;
    kills += ek;
    bosses += bek;
  }
  let histTotal = 0;
  for (const p of Object.values(per)) histTotal += Number(p.hist_total) || 0;
  return { chars: chars.length, max_level: maxLevel, gold, exp, kills, bosses, hist_total: histTotal, per };
}

/** ค่าที่เป็นไปไม่ได้เลย ไม่ว่าจะเล่นมานานแค่ไหน */
function hardFaults(prog, lim) {
  const bad = [];
  for (const [name, p] of Object.entries(prog.per)) {
    if (!Number.isInteger(p.level) || p.level < 1 || p.level > MAX_LEVEL)
      bad.push(`${name}: เลเวล ${p.level} (ต้องเป็น 1-${MAX_LEVEL})`);
    if (!Number.isFinite(p.gold) || p.gold < 0 || p.gold > lim.goldCap)
      bad.push(`${name}: เงิน ${p.gold} (ต้องเป็น 0-${lim.goldCap})`);
  }
  if (prog.chars > 40) bad.push(`ตัวละคร ${prog.chars} ตัว (มากผิดปกติ)`);
  return bad;
}

/**
 * ความก้าวหน้าโตเร็วเกินจริงไหม เทียบกับเซฟที่รับไว้ก่อนหน้า
 * @param prev {level, gold, t} สถานะที่รับไว้ครั้งก่อน (null = ครั้งแรก)
 */
function rateFaults(prog, prev, nowMs, lim, canTrade = true) {
  const bad = [];
  if (!prev || prev.first) return { bad, use: null };   // ไม่มีฐานเทียบ / เซฟแรก (กฎ 1 จัดการแล้ว)
  const hours = Math.max(0, (nowMs - num(prev.t)) / 3_600_000);

  const expGain = prog.exp - num(prev.exp);
  const killGain = Math.max(0, prog.kills - num(prev.kills));
  // v79.0: บอสที่ล้มในช่วงนี้ได้โควตาของตัวเอง ที่เหลือคิดด้วยเพดานมอนธรรมดา
  const bossGain = Math.min(killGain, Math.max(0, prog.bosses - num(prev.bosses)));
  const trashGain = Math.max(0, killGain - bossGain);

  // โควตาที่เหลือของบัญชีนี้ (v79.5: ใช้แล้วหมด ไม่ได้คืนทุกคำขอ)
  const graceExpLeft = Math.max(0, GRACE_EXP_TOTAL - num(prev.grace_exp));
  const graceGoldLeft = Math.max(0, GRACE_GOLD_TOTAL - num(prev.grace_gold));
  // ถังเงินเทรด: เติมตามเวลาที่ผ่านไป เพดานเท่า TRADE_GOLD_BURST
  // v79.5: บัญชีที่ยังไม่ผ่านด่านเทรด (ดู lib/gate.js) เทรดไม่ได้จริง -> ไม่ควรมีโควตาเงินเทรดเลย
  //        ปิดช่องปั้นเงินโดยไม่เล่น: เหลือแค่เงินจากการฆ่า + โควตาเริ่มต้นทั้งชีวิต
  const bucket = canTrade ? Math.min(TRADE_GOLD_BURST, num(prev.gbucket) + TRADE_GOLD_PER_HOUR * hours) : 0;

  const use = { grace_exp: num(prev.grace_exp), grace_gold: num(prev.grace_gold), gbucket: bucket };

  // ---------- กฎ 3: เลเวล (EXP) ต้องมาจากการฆ่า ----------
  // ใช้ exp_kills ซึ่งรวม "ตัวที่เพื่อนในปาร์ตี้ฆ่าแล้วเราได้ EXP ด้วย"
  // ไปปาร์ตี้แล้วไม่ลงดาบเลยก็ยังถูกนับ -> ไม่โดนแบนฟรี
  if (expGain > 0) {
    const fromKills = trashGain * lim.expPerKill + bossGain * lim.bossExpPerKill;
    const over = expGain - fromKills;
    if (over > graceExpLeft)
      bad.push(`ได้ EXP ${Math.round(expGain).toLocaleString()} จากการฆ่าเพียง ${killGain} ตัว (บอส ${bossGain} ตัว, เพดานจากการฆ่า ${Math.round(fromKills).toLocaleString()} + โควตาที่เหลือ ${Math.round(graceExpLeft).toLocaleString()})`);
    else if (over > 0)
      use.grace_exp = num(prev.grace_exp) + over;
  }

  // ---------- กฎ 2: เงินต้องมาจากการฆ่า (เผื่อโควตาเทรด/ตลาดประมูลไว้) ----------
  const goldGain = prog.gold - num(prev.gold);
  if (goldGain > 0) {
    const fromKills = killGain * lim.goldPerKill;
    const over = goldGain - fromKills;
    if (over > bucket + graceGoldLeft) {
      bad.push(`ได้เงิน ${Math.round(goldGain).toLocaleString()} จากการฆ่าเพียง ${killGain} ตัว ในเวลา ${hours.toFixed(2)} ชม. (เพดานจากการฆ่า ${Math.round(fromKills).toLocaleString()} + โควตาเทรดที่เหลือ ${Math.round(bucket).toLocaleString()})`);
    } else if (over > 0) {
      const fromBucket = Math.min(bucket, over);
      use.gbucket = bucket - fromBucket;
      if (over > fromBucket) use.grace_gold = num(prev.grace_gold) + (over - fromBucket);
    }
    if (goldGain > lim.goldPerHour * (hours + 1))
      bad.push(`เงินเพิ่ม ${Math.round(goldGain).toLocaleString()} ในเวลา ${hours.toFixed(2)} ชม. (เร็วเกินจริง)`);
  }
  return { bad, use };
}

/**
 * กฎ 1: เซฟแรกของบัญชีใหม่ต้องเป็นตัวละครใหม่จริง
 * ฐานนี้ถูกจดไว้ตั้งแต่ตอนสมัคร -> ปลอมไม่ได้ เพราะเวลามาจากเซิร์ฟเวอร์
 */
function firstSaveFaults(prog, prev) {
  const bad = [];
  if (!prev || !prev.first) return bad;
  if (prog.max_level > FIRST_LEVEL_MAX)
    bad.push(`บัญชีใหม่แต่เซฟแรกเป็นเลเวล ${prog.max_level} (เริ่มใหม่ต้องไม่เกิน ${FIRST_LEVEL_MAX})`);
  if (prog.gold > FIRST_GOLD_MAX)
    bad.push(`บัญชีใหม่แต่เซฟแรกมีเงิน ${Math.round(prog.gold).toLocaleString()} (เริ่มใหม่ต้องไม่เกิน ${FIRST_GOLD_MAX.toLocaleString()})`);
  if (prog.kills > FIRST_KILLS_MAX)
    bad.push(`บัญชีใหม่แต่เซฟแรกฆ่าไปแล้ว ${prog.kills} ตัว (เริ่มใหม่ต้องไม่เกิน ${FIRST_KILLS_MAX})`);
  return bad;
}

/** น่าสงสัยแต่ยังไม่ถึงกับเป็นไปไม่ได้ -> ผ่าน แต่ติดธงให้ผู้ดูแลดู */
function sanityFlags(prog, prev) {
  const out = [];
  if (!prev) return out;
  const killGain = Math.max(0, prog.kills - num(prev.kills));
  const bossGain = Math.min(killGain, Math.max(0, prog.bosses - num(prev.bosses)));
  const trashGain = Math.max(0, killGain - bossGain);
  const expGain = prog.exp - num(prev.exp);
  const goldGain = prog.gold - num(prev.gold);
  if (expGain > (trashGain + FIRST_KILLS_MAX) * EXP_PER_KILL_SANE + bossGain * BOSS_EXP_PER_KILL_SANE)
    out.push(`EXP ${Math.round(expGain).toLocaleString()} ต่อการฆ่า ${killGain} ตัว (บอส ${bossGain} ตัว) สูงกว่าปกติมาก`);
  if (goldGain > (killGain + FIRST_KILLS_MAX) * GOLD_PER_KILL_SANE + TRADE_GOLD_BURST)
    out.push(`เงิน ${Math.round(goldGain).toLocaleString()} ต่อการฆ่า ${killGain} ตัว สูงกว่าปกติมาก (ถ้าไม่ได้มาจากเทรด)`);
  return out;
}

// ======================== v78.5: กฎ "ความเป็นไปได้" ของไอเทม ========================
// ตัวเลขทั้งหมดอิงค่าจริงในเกม: ItemRules.RARITY_NAMES, GameData.REQ_LEVEL_BY_RARITY,
// InventoryUI.COLS x ROWS (12x5 = 60 ช่อง), GameData.GEAR_SLOTS (9 ช่องสวม)
export const RARITIES = ["normal", "magic", "rare", "unique", "costume", ""];
export const MAX_BAG = 60;
export const MAX_GEAR = 12;
export const MAX_STASH = 600;
export const MAX_COSTUME = 12;         // v79.5: ช่องคอสตูม (เดิมไม่จำกัด -> ยัดได้เป็นหมื่นชิ้น)
export const MAX_ITEMS_TOTAL = 1500;   // v79.5: เพดานไอเทมรวมทั้งเซฟ (กระเป๋า+สวม+คอสตูม+คลัง ของทุกตัวละคร)
// v79.7: เพดานค่าสถานะต่อบรรทัดเดิม 100,000 ซึ่งกว้างเกินจริงมาก
//   -> สวมของ 9 ชิ้น ชิ้นละ life 100,000 = เลือดเกือบล้าน และผ่านด่านได้สบาย
// ค่าจริงในเกมที่เลเวล 100: ออฟชั่นแรงสุด ~228 (accuracy) | ค่าฐานของแม่แบบแรงสุด 150 x 3.0 = 450
//   (ItemRules.level_scale(100) = 3.8 | base_scale(100) = 3.0 | ค่าใหญ่สุดในตารางไอเทมคือ evasion 150)
// ตั้งเพดานไว้ 3,000 = เผื่อไว้ราว 7 เท่าของค่าแรงสุดที่เป็นไปได้
export const MAX_STAT = 3000;          // ค่าสถานะต่อบรรทัดของไอเทมชิ้นเดียว
export const MAX_STAT_LEGACY = 100000; // v79.7: โหมดผ่อนผันช่วงเปลี่ยน (SOF_ITEM_STAT_LEGACY=1)

export function maxStat() {
  return String(process.env.SOF_ITEM_STAT_LEGACY || "") === "1" ? MAX_STAT_LEGACY : MAX_STAT;
}
export const MAX_AFFIX = 12;           // จำนวนออฟต่อชิ้น

const STAT_KEYS_SKIP = new Set(["name", "id", "uid", "slot", "rarity", "icon", "icon_tex", "desc", "costume", "quiver", "shape", "where"]);

/** ไอเทมชิ้นนี้เป็นไปได้ไหม -> คืนข้อความบอกเหตุ ("" = ผ่าน) */
export function itemFault(it, whose) {
  if (!it || typeof it !== "object") return "";
  const r = String(it.rarity ?? "");
  if (!RARITIES.includes(r)) return `${whose}: ความหายาก "${r}" ไม่มีในเกม`;
  const lv = Number(it.req_level ?? it.level ?? 0);
  if (Number.isFinite(lv) && (lv < 0 || lv > MAX_LEVEL)) return `${whose}: req_level ${lv}`;
  let affixes = 0;
  for (const [k, v] of Object.entries(it)) {
    if (STAT_KEYS_SKIP.has(k)) continue;
    if (typeof v !== "number") continue;
    if (!Number.isFinite(v)) return `${whose}: ค่า ${k} ไม่ใช่ตัวเลขที่ใช้ได้`;
    const cap = maxStat();
    if (Math.abs(v) > cap) return `${whose}: ค่า ${k} = ${v} (เพดาน ${cap})`;
    affixes++;
  }
  if (affixes > MAX_AFFIX * 3) return `${whose}: มีค่าสถานะ ${affixes} บรรทัด (มากผิดปกติ)`;
  return "";
}

/** ไอเทมทั้งหมดในเซฟ -> [{item, where}] + ตรวจจำนวนช่อง */
export function itemsOfSave(save) {
  const out = [];
  const faults = [];
  for (const c of charsOfSave(save)) {
    const inv = c.inventory || {};
    const grid = Array.isArray(inv.grid) ? inv.grid : [];
    if (grid.length > MAX_BAG) faults.push(`${c.name}: กระเป๋า ${grid.length} ช่อง (เพดาน ${MAX_BAG})`);
    for (const g of grid) if (g && g.item) out.push({ it: g.item, where: `${c.name}/กระเป๋า` });
    const eq = inv.equipment && typeof inv.equipment === "object" ? inv.equipment : {};
    if (Object.keys(eq).length > MAX_GEAR) faults.push(`${c.name}: ช่องสวม ${Object.keys(eq).length} ช่อง (เพดาน ${MAX_GEAR})`);
    for (const [slot, it] of Object.entries(eq)) if (it && Object.keys(it).length) out.push({ it, where: `${c.name}/สวม:${slot}` });
    // v79.5: เดิมไม่จำกัดจำนวนช่องคอสตูม -> ส่งมา 20,000 ชิ้นได้ แล้ว uidConflicts ยิง Redis 40,000 ครั้งต่อหนึ่งคำขอ
    const cos = inv.costume && typeof inv.costume === "object" ? inv.costume : {};
    if (Object.keys(cos).length > MAX_COSTUME) faults.push(`${c.name}: ช่องคอสตูม ${Object.keys(cos).length} ช่อง (เพดาน ${MAX_COSTUME})`);
    for (const [slot, it] of Object.entries(cos)) if (it && Object.keys(it).length) out.push({ it, where: `${c.name}/คอสตูม:${slot}` });
  }
  for (const [name, text] of Object.entries((save && save.files) || {})) {
    if (!name.startsWith("stash_")) continue;
    const st = parse(text);
    const tabs = st && Array.isArray(st.tabs) ? st.tabs : [];
    let n = 0;
    for (const tab of tabs) for (const it of tab || []) if (it && Object.keys(it).length) { out.push({ it, where: "คลังบัญชี" }); n++; }
    if (n > MAX_STASH) faults.push(`คลังบัญชี ${n} ชิ้น (เพดาน ${MAX_STASH})`);
  }
  if (out.length > MAX_ITEMS_TOTAL) faults.push(`ไอเทมรวมทั้งเซฟ ${out.length} ชิ้น (เพดาน ${MAX_ITEMS_TOTAL})`);
  return { items: out.slice(0, MAX_ITEMS_TOTAL), faults };
}

const uidKey = (uid) => "sof:uid:" + String(uid).slice(0, 48);

/**
 * uid ซ้ำข้ามบัญชีไหม
 * หมายเหตุสำคัญ: ของย้ายเจ้าของได้จริง (เทรด / คลังกิลด์) -> "uid เปลี่ยนบัญชี" ไม่ใช่การโกงเสมอไป
 * ค่าตั้งต้นจึงเป็น "บันทึกไว้ให้ /admin ดู" ไม่ใช่ปฏิเสธเซฟ (ไม่งั้นเทรดปกติจะพัง)
 * ถ้าอยากให้ปฏิเสธไปเลย ตั้ง env SOF_UID_STRICT=1
 */
export async function uidConflicts(user, items, nowMs) {
  const u = String(user).toLowerCase();
  const hits = [];
  // v79.5: เดิมอ่าน+เขียน Redis ทีละชิ้นแบบต่อคิว (ของ 20,000 ชิ้น = 40,000 รอบ)
  //        ตอนนี้อ่านเป็นชุด และคีย์มีวันหมดอายุ (เดิมไม่มี -> คีย์ค้างถาวร)
  const uniq = new Map();
  for (const { it, where } of items) {
    const uid = it && it.uid ? String(it.uid) : "";
    if (!uid || uniq.has(uid)) continue;
    uniq.set(uid, where);
  }
  const uids = [...uniq.keys()];
  if (!uids.length) return hits;
  const prevs = await store.mgetBatched(uids.map(uidKey), 100);
  for (let i = 0; i < uids.length; i++) {
    const prev = parse(prevs[i]);
    if (prev && String(prev.u).toLowerCase() !== u && nowMs - Number(prev.t || 0) < UID_WINDOW_MS)
      hits.push(`${uniq.get(uids[i])}: ของชิ้น ${uids[i]} เพิ่งอยู่กับบัญชี ${prev.u}`);
  }
  // เขียนกลับเฉพาะชิ้นที่เจ้าของเปลี่ยน หรือบันทึกไว้นานแล้ว -> ลดจำนวนคำสั่งลงมาก
  for (let i = 0; i < uids.length; i++) {
    const prev = parse(prevs[i]);
    const fresh = prev && String(prev.u).toLowerCase() === u && nowMs - Number(prev.t || 0) < UID_WINDOW_MS / 2;
    if (fresh) continue;
    await store.setex(uidKey(uids[i]), Math.ceil(UID_WINDOW_MS / 1000) * 2, JSON.stringify({ u: user, t: nowMs, w: uniq.get(uids[i]) }));
  }
  return hits;
}
const UID_WINDOW_MS = 10 * 60_000;     // เจอซ้ำภายในกี่นาทีถึงนับว่าน่าสงสัย

export function uidStrict() {
  return String(process.env.SOF_UID_STRICT || "") === "1";
}

const progKey = (user) => "sof:prog:" + String(user).toLowerCase();
export const flagKey = (user) => "sof:cheatflag:" + String(user).toLowerCase();

/** สถานะความก้าวหน้าที่รับไว้ครั้งก่อน */
export async function lastProgress(user) {
  return parse(await store.get(progKey(user)));
}

/**
 * จำสถานะล่าสุดที่รับเข้าไว้ (ใช้เทียบครั้งถัดไป)
 * v79.4: นับ "จำนวนช่วงชั่วโมงที่มีการเล่นจริง" ไปด้วย (ph)
 *   = ชั่วโมงที่มีเซฟผ่านด่านเข้ามาอย่างน้อยหนึ่งก้อน นับช่วงละครั้ง
 *   ใช้เป็นด่านก่อนแตะเศรษฐกิจ แทน "อายุบัญชี" ซึ่งแค่ปล่อยทิ้งไว้ก็ครบ
 *   ไม่เพิ่มคีย์ใหม่ใน Redis — เก็บไว้ในระเบียนความก้าวหน้าเดิม
 */
export async function rememberProgress(user, prog, nowMs) {
  const prevRec = parse(await store.get(progKey(user)));
  const hour = Math.floor(nowMs / 3_600_000);
  const lastHour = prevRec ? Number(prevRec.ph_h || 0) : 0;
  const ph = (prevRec ? Number(prevRec.ph || 0) : 0) + (hour !== lastHour ? 1 : 0);
  // v79.5: โควตาที่ใช้ไปต้องถูกจดไว้ ไม่งั้นทุกคำขอได้โควตาใหม่ (ดู rateFaults)
  const u = prog.use || {};
  await store.set(progKey(user), JSON.stringify({
    level: prog.max_level, gold: prog.gold, exp: prog.exp, kills: prog.kills, bosses: prog.bosses, t: nowMs,
    ph, ph_h: hour, ph_first: prevRec && prevRec.ph_first ? Number(prevRec.ph_first) : nowMs,
    // v79.8: เส้นฐานจำนวนที่ฆ่า — จดครั้งเดียวตอนเห็นบัญชีนี้ครั้งแรกหลังกฎมีผล
    kills0: prevRec && prevRec.kills0 != null ? Number(prevRec.kills0) : Math.max(0, num(prog.kills)),
    grace_exp: Number(u.grace_exp) || (prevRec ? Number(prevRec.grace_exp) || 0 : 0),
    grace_gold: Number(u.grace_gold) || (prevRec ? Number(prevRec.grace_gold) || 0 : 0),
    gbucket: u.gbucket != null ? Number(u.gbucket) : (prevRec ? Number(prevRec.gbucket) || 0 : 0),
    hist_seen: ((prevRec && Number(prevRec.hist_seen)) || Number(prog.hist_total) > 0) ? 1 : 0,
  }));
}

/**
 * v78.8 กฎ 1: ตั้งฐานให้บัญชีใหม่ตั้งแต่ตอนสมัคร
 * เวลานี้มาจากเซิร์ฟเวอร์ -> ปลอมไม่ได้ ทำให้ "เสกตัวละครเสร็จรูปขึ้นมาเป็นเซฟแรก" ทำไม่ได้
 * (เดิมเซฟแรกไม่มีอะไรให้เทียบเลย เหลือแค่เพดานตายตัว)
 */
export async function startProgress(user, nowMs = Date.now()) {
  await store.set(progKey(user), JSON.stringify({ level: 1, gold: 0, exp: 0, kills: 0, bosses: 0, t: nowMs,
    first: true, grace_exp: 0, grace_gold: 0, gbucket: TRADE_GOLD_BURST, kills0: 0, ph: 0 }));
}

/** บันทึกธงว่าบัญชีนี้ส่งเซฟที่เป็นไปไม่ได้ (หน้า /admin อ่านได้) */
// v80.3: ของเดิมเว้น 10 นาทีต่อการนับหนึ่งครั้ง -> "ยิ่งโกงเร็ว ยิ่งแบนช้า" ซึ่งกลับหัวกลับหาง
//        คนยัดค่า 32 ครั้งรวดในไม่กี่นาที นับได้แค่ 1 ครั้ง ต้องใช้เวลา 40 นาทีกว่าจะครบ 5
//        ลดเหลือ 2 นาที: คนโกงรัวๆ ครบใน ~8 นาที ส่วนคนที่ชนกฎพลาดครั้งเดียวยังไม่โดนอะไร
export const STRIKE_GAP_MS = 2 * 60_000;    // v80.3: นับ "ครั้ง" ได้ไม่ถี่กว่านี้ (เดิม 10 นาที)

// v80.3: นับตาม "ชนิดกฎที่ไม่ซ้ำกัน" ในเซฟก้อนเดียว
//   คนเล่นจริงที่โดนกฎพลาด จะชนกฎเดียวโดดๆ
//   ส่วนเซฟที่ถูกแก้ด้วยมือมักชนหลายกฎพร้อมกัน (แต้มสถานะ + แต้มต้นไม้ + เลเวลเกินที่ฆ่ามา)
//   -> เซฟเดียวที่ชน 3 ชนิด = นับ 3 ครั้งทันที
export const STRIKE_MAX_PER_EVENT = 3;      // เพดานกันนับพรวดจากเซฟก้อนเดียว

const FAULT_KINDS = [
  [/ลงแต้มสถานะ|แต้ม .* ติดลบ/, "แต้มสถานะ"],
  [/ลงแต้มต้นไม้/, "แต้มต้นไม้"],
  [/บททดสอบเผ่า|โหนดเผ่า/, "เผ่า"],
  [/รูนบนกระดาน|รูนในถุง/, "รูน"],
  [/ฆ่าสะสมเพิ่มขึ้น/, "ฆ่าเกินเวลาเล่น"],
  [/ประวัติบอกว่าฆ่า|ไม่มีประวัติว่าฆ่ามอน|พาไปได้สูงสุดเลเวล/, "เลเวลเกินที่ฆ่ามา"],
  [/บัญชีใหม่แต่เซฟแรก/, "เซฟแรกของบัญชีใหม่"],
  [/\(ต้องเป็น |มากผิดปกติ\)/, "เกินเพดานตายตัว"],
];

/** ชนิดกฎที่ไม่ซ้ำกันของเหตุผลชุดนี้ (ใช้ตัดสินว่านับกี่ครั้ง) */
export function faultKinds(reasons) {
  const out = new Set();
  for (const r of reasons || []) {
    for (const [re, kind] of FAULT_KINDS) {
      if (re.test(String(r))) { out.add(kind); break; }
    }
  }
  return [...out];
}

export async function flag(user, reasons, nowMs, hard = false) {
  const cur = parse(await store.get(flagKey(user))) || { n: 0, first: nowMs, items: [], strikes: 0 };
  cur.n += 1;
  // v79.2: เกมอัปเซฟใหม่ทุก 15 วินาที -> ถ้านับทุกครั้งที่ถูกปฏิเสธ คนที่โดนกฎพลาดจะถูกแบนในนาทีเดียว
  //        จึงนับเป็น "ครั้ง" ได้ไม่ถี่กว่า STRIKE_GAP_MS และนับแค่กรณี hard (ค่าที่เขียนขึ้นเองแน่ๆ)
  if (hard && nowMs - Number(cur.strike_at || 0) >= STRIKE_GAP_MS) {
    // v80.3: ชนกฎหลายชนิดในเซฟเดียว = นับเท่าจำนวนชนิด (อย่างน้อย 1 สูงสุด STRIKE_MAX_PER_EVENT)
    const kinds = faultKinds(Array.isArray(hard) ? hard : reasons);
    const add = Math.min(Math.max(1, kinds.length), STRIKE_MAX_PER_EVENT);
    cur.strikes = Number(cur.strikes || 0) + add;
    cur.strike_at = nowMs;
    cur.last_kinds = kinds;
  }
  cur.last = nowMs;
  cur.items = [...(cur.items || []), { t: nowMs, reasons, hard: !!hard }].slice(-20);
  await store.set(flagKey(user), JSON.stringify(cur));
  return { n: cur.n, strikes: Number(cur.strikes || 0) };
}

/**
 * ตรวจเซฟก่อนรับ -> {ok:true, prog} หรือ {ok:false, reasons:[...]}
 * บัญชีที่อยู่ใน SOF_ANTICHEAT_EXEMPT (คั่นด้วย ,) ข้ามการตรวจอัตรา (ไว้ให้บัญชีทดสอบของผู้พัฒนา)
 */
export async function checkSave(user, save, nowMs = Date.now(), opts = {}) {
  const lim = limits();
  const prog = progressOf(save);
  const exempt = String(process.env.SOF_ANTICHEAT_EXEMPT || "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)
    .includes(String(user).toLowerCase());
  const prev = await lastProgress(user);

  // v79.2: แยกสองกลุ่ม
  //   hard = "ค่านี้เขียนขึ้นเองแน่ๆ" (เกินเพดานตายตัว / เซฟแรกของบัญชีใหม่ / เลเวลที่มอนพาไปไม่ถึง / ไอเทมไม่มีในเกม)
  //   soft = "อัตราเร็วเกินจริง" (เงิน/EXP ต่อชั่วโมง) ซึ่งมีโอกาสพลาดใส่คนเล่นจริงมากกว่า
  // แบนอัตโนมัตินับแค่ hard เท่านั้น
  const hard = hardFaults(prog, lim);
  // v79.7: แต้มสถานะ/ต้นไม้/โหนดเผ่า เกินสิทธิ์ = เซฟที่ถูกแก้แน่ๆ (ตรวจได้จากเซฟก้อนเดียว)
  hard.push(...statFaults(save));
  if (!exempt) {
    hard.push(...firstSaveFaults(prog, prev));
    // v79.8: จำนวนที่ฆ่าต้องผูกกับเวลาเล่นจริง (ปิดปลายสาย แต้ม <- เลเวล <- EXP <- ฆ่า <- เวลา)
    hard.push(...killRateFaults(prog, prev));
    // v79.1: เลเวลต้องเป็นไปได้จากมอนที่ฆ่ามา (ตรวจได้จากเซฟก้อนเดียว ไม่ต้องมีเซฟก่อนหน้า)
    hard.push(...historyFaults(prog, prev));
  }
  // v78.5: ไอเทมต้องเป็นไปได้ด้วย (ความหายาก/req_level/ค่าสถานะ/จำนวนช่อง)
  // v79.3: ย้ายมาเป็น soft — ของเข้ากระเป๋าได้จากเทรด/คลังกิลด์/ของดรอป
  //        ถ้าใครยัดของค่าเกินจริงให้คนปกติ เซฟเขาจะถูกปฏิเสธโดยที่เขาไม่ได้ทำอะไรผิด
  //        -> ยังไม่รับเซฟ (ไม่ให้ของพังๆ ขึ้นไปอยู่บนเซิร์ฟเวอร์) แต่ไม่นับเข้าแบนอัตโนมัติ
  //        และต้นทางถูกปิดที่ /api/gstash กับด่านเทรดแล้ว
  const itemBad = [];
  const { items, faults } = itemsOfSave(save);
  itemBad.push(...faults);
  for (const { it, where } of items) {
    const f = itemFault(it, where);
    if (f) itemBad.push(f);
    if (itemBad.length > 20) break;
  }
  const canTrade = opts.canTrade !== false;
  const rate = exempt ? { bad: [], use: null } : rateFaults(prog, prev, nowMs, lim, canTrade);
  const soft = [...itemBad, ...rate.bad];
  const reasons = [...hard, ...soft];
  if (reasons.length) return { ok: false, reasons, prog, exempt, hard: hard.length > 0, hard_reasons: hard };
  prog.use = rate.use;   // v79.5: ยอดโควตาที่ถูกใช้ไปในการรับเซฟครั้งนี้
  // ของชิ้นเดียวกันโผล่สองบัญชีพร้อมกัน -> บันทึกไว้ (หรือปฏิเสธ ถ้าตั้ง SOF_UID_STRICT=1)
  const dups = exempt ? [] : await uidConflicts(user, items, nowMs);
  if (dups.length && uidStrict()) return { ok: false, reasons: dups, prog };
  const odd = exempt ? [] : sanityFlags(prog, prev);
  return { ok: true, prog, exempt, dups: [...dups, ...odd] };
}
