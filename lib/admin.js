// lib/admin.js -- v35: ข้อมูลหลังบ้านสำหรับผู้ดูแลเกม (หน้า /admin)
// เข้าได้เฉพาะบัญชีผู้ดูแล (บัญชีผู้พัฒนา + env SOF_ADMIN_USERS) — ใช้ token จากการล็อกอินปกติ
// อ่านอย่างเดียว: ไม่แก้/ไม่ลบข้อมูลผู้เล่น | ไม่ส่งรหัสผ่าน (hash/salt) หรือ token ของผู้เล่นออกไป
// POST {action:"overview"|"players"|"player"|"rooms", token, user?, fresh?}
import * as store from "./store.js";
import { userOf, isAdmin, adminKeyOk, adminKeyRequired } from "./accounts.js";
import { clientIp, STALE_MS } from "./lobby.js";
import { allTx, ownedOf, CATALOG, PRICE_CENTS, CURRENCY, shopEnabled } from "./shop.js";
import { handleWipe } from "./reset.js";
import { statsAll as dungeonStats } from "./dungeon.js";
import { bucketsOfChar, maxLevelFrom } from "./anticheat.js";
import { ban, unban, unrestrict, listBans, banInfo, autoBanFlags, autoBanOn } from "./bans.js";
import { tradeGate, minHours, minLevel } from "./gate.js";

const RACES = ["มนุษย์", "โครงกระดูก", "พระ", "แวมไพร์", "ทาส", "ซอมบี้", "ออร์ค", "มนุษย์หมาป่า"];
const QUEST_TITLES = {
  q_start: "ก้าวแรกแห่งโชคชะตา", q_elder_bones: "กระดูกที่ไม่ยอมหลับ", q_market_mushroom: "เห็ดแดงต้องห้าม",
  q_smith_bomb: "ดินระเบิดเดินได้", q_guard_visit: "สำรวจสุสานใต้ดิน", q_trader_spider: "ใยแมงมุมขนปุย", q_gate_king: "ราชาแห่งสุสาน",
};
const CACHE_MS = 60_000;
let cache = null;   // {t, rows}

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};
const DAY = 86_400_000;

// ---------- สรุปตัวละคร / บัญชี ----------
function itemsOfInventory(inv) {
  const out = [];
  if (!inv || typeof inv !== "object") return out;
  for (const g of inv.grid || []) if (g && g.item) out.push({ where: "กระเป๋า", ...g.item });
  for (const [slot, it] of Object.entries(inv.equipment || {})) if (it && Object.keys(it).length) out.push({ where: "สวม:" + slot, ...it });
  for (const [slot, it] of Object.entries(inv.costume || {})) if (it && Object.keys(it).length) out.push({ where: "คอสตูม:" + slot, ...it });
  for (const it of inv.wardrobe || []) if (it && Object.keys(it).length) out.push({ where: "ตู้คอสตูม", ...it });
  return out;
}

// v78.9: ชื่อบอส/มินิบอสสำหรับหน้าสถิติ (ตรงกับ Monster.TYPES ในตัวเกม)
const BOSS_NAMES = {
  skeleton_king: "ราชาโครงกระดูก",
  skeleton_captain: "หัวหน้าองครักษ์กระดูก",
  skeleton_warden: "ผู้คุมสุสาน",
};

export function summarizeChar(c) {
  const inv = c.inventory || {};
  // v79.1: เลเวลสูงสุดที่มอนซึ่งฆ่ามาพาไปได้ (คำนวณแบบใจกว้างสุด) — ต่ำกว่าเลเวลจริงมากคือน่าสงสัย
  const bk = bucketsOfChar(c);
  const q = c.quests || {};
  const qs = Object.values(q).map((x) => (x && x.state) || "");
  return {
    name: String(c.name || "?"),
    race: Number.isInteger(c.race) ? c.race : Number(c.race) || 0,
    race_name: RACES[Number(c.race) || 0] || "?",
    gender: Number(c.gender) || 0,
    level: Number(c.level) || 1,
    exp: Number(c.exp) || 0,
    gold: Number(inv.gold) || 0,
    items: itemsOfInventory(inv).length,
    equipped: Object.keys(inv.equipment || {}).length,
    quests_done: qs.filter((s) => s === "turned").length,
    boss_kills: c.boss_kills && typeof c.boss_kills === "object" ? c.boss_kills : {},
    kills: Number(c.kills) || 0,
    exp_kills: Number(c.exp_kills) || 0,
    boss_exp_kills: Number(c.boss_exp_kills) || 0,
    dungeon_resets: Number(c.dungeon_resets) || 0,
    kill_levels: bk.total,
    reachable_level: bk.total > 0 ? maxLevelFrom(bk.buckets) : 0,
    quest_states: Object.fromEntries(Object.entries(q).map(([id, x]) => [id, (x && x.state) || ""])),
    quests_active: qs.filter((s) => s === "active" || s === "complete").length,
    tutorial_done: c.tutorial_done !== false,
    tree_points: Array.isArray(c.passive_tree) ? c.passive_tree.length : 0,
    runes: c.runes ? ((c.runes.bag || []).length + (c.runes.placed || []).length) : 0,
    waypoints: Array.isArray(c.waypoints) ? c.waypoints.length : 0,
    pet: String(c.pet || ""),
    guild: c.guild ? String(c.guild.name || c.guild || "") : "",
  };
}

function charsOf(save, user) {
  if (!save || !save.files) return [];
  const f = Object.entries(save.files).find(([k]) => k.startsWith("characters_"));
  const list = f ? parse(f[1]) : null;
  return Array.isArray(list) ? list.filter((c) => c && typeof c === "object" && c.name) : [];
}

function stashOf(save) {
  if (!save || !save.files) return null;
  const f = Object.entries(save.files).find(([k]) => k.startsWith("stash_"));
  return f ? parse(f[1]) : null;
}

function socialOf(save) {
  if (!save || !save.files) return null;
  const f = Object.entries(save.files).find(([k]) => k.startsWith("social_"));
  return f ? parse(f[1]) : null;
}

function stashItems(stash) {
  const out = [];
  if (stash && Array.isArray(stash.tabs)) for (const t of stash.tabs) for (const it of t || []) if (it && Object.keys(it).length) out.push(it);
  return out;
}

async function loadAll() {
  const acctKeys = await store.scanPrefix("sof:acct:");
  const accts = (await store.mgetBatched(acctKeys, 100)).map(parse);
  const users = accts.map((a, i) => (a && a.user) || acctKeys[i].slice(9));
  const saveRaw = await store.mgetBatched(users.map((u) => "sof:save:" + u.toLowerCase()), 20);
  const rows = [];
  for (let i = 0; i < users.length; i++) {
    const a = accts[i] || {};
    const raw = saveRaw[i];
    const save = parse(raw);
    const chars = charsOf(save, users[i]);
    const stash = stashOf(save);
    const social = socialOf(save);
    const uids = [];
    for (const c of chars) for (const it of itemsOfInventory(c.inventory)) if (it.uid) uids.push([String(it.uid), c.name, it.name || it.id || "?"]);
    for (const it of stashItems(stash)) if (it.uid) uids.push([String(it.uid), "(คลังบัญชี)", it.name || it.id || "?"]);
    rows.push({
      user: users[i],
      created: Number(a.created) || 0,
      last_login: Number(a.lastLogin) || 0,
      logins: Number(a.logins) || 0,
      saved_at: save ? Number(save.saved_at || save.t) || 0 : 0,
      save_bytes: typeof raw === "string" ? raw.length : raw ? JSON.stringify(raw).length : 0,
      chars: chars.map(summarizeChar),
      stash_items: stashItems(stash).length,
      friends: social && Array.isArray(social.friends) ? social.friends.length : 0,
      _uids: uids,
    });
  }
  return rows;
}

async function rows(fresh) {
  if (!fresh && cache && Date.now() - cache.t < CACHE_MS) return cache;
  cache = { t: Date.now(), rows: await loadAll() };
  return cache;
}

const publicRow = (r) => {
  const { _uids, ...rest } = r;
  const lv = r.chars.reduce((m, c) => Math.max(m, c.level), 0);
  return { ...rest, max_level: lv, gold: r.chars.reduce((s, c) => s + c.gold, 0), last_active: Math.max(r.saved_at, r.last_login) };
};

// ---------- ห้อง / ออนไลน์ ----------
async function allRooms() {
  const ids = await store.smembers("sof:rooms");
  const vals = await store.mget(ids.map((i) => "sof:room:" + i));
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const r = parse(vals[i]);
    if (!r) continue;
    const age = Date.now() - (r.updated || 0);
    out.push({ id: r.id, name: r.name, host: r.host, players: r.players, max: r.max, proto: r.proto, transport: r.transport || "enet",
      channel: r.channel || 1, dedicated: !!r.dedicated, updated: r.updated, live: age <= STALE_MS, address: r.transport === "webrtc" ? "WebRTC" : r.ip + ":" + r.port });
  }
  out.sort((a, b) => b.live - a.live || b.players - a.players);
  return out;
}

// ---------- ภาพรวม ----------
async function overview(rs, rooms) {
  const now = Date.now();
  const chars = rs.flatMap((r) => r.chars.map((c) => ({ ...c, user: r.user })));
  const days = 30;
  const dayKey = (t) => new Date(t + 7 * 3600_000).toISOString().slice(0, 10);   // วันตามเวลาไทย
  const signups = {}, active = {};
  for (let d = days - 1; d >= 0; d--) { const k = dayKey(now - d * DAY); signups[k] = 0; active[k] = 0; }
  for (const r of rs) {
    if (r.created && signups[dayKey(r.created)] !== undefined) signups[dayKey(r.created)]++;
    const la = Math.max(r.saved_at, r.last_login);
    if (la && active[dayKey(la)] !== undefined) active[dayKey(la)]++;
  }
  const levels = {};
  for (const c of chars) { const b = Math.min(100, Math.floor((c.level - 1) / 5) * 5 + 1); levels[b] = (levels[b] || 0) + 1; }
  const races = RACES.map((n, i) => ({ race: n, count: chars.filter((c) => c.race === i).length }));
  // เควส: กี่ตัวละครรับแล้ว / ส่งแล้ว (ดูว่าผู้เล่นติดเควสไหน)
  const quests = Object.entries(QUEST_TITLES).map(([id, title]) => ({
    id, title,
    accepted: chars.filter((c) => c.quest_states[id]).length,
    turned: chars.filter((c) => c.quest_states[id] === "turned").length,
  }));
  // v78.9: สถิติบอส — รวมทุกบัญชี แยกตามชนิดและเลเวล (บอสมีชั้นละตัว ฆ่าซ้ำต้องรีดันเจี้ยน)
  const bossMap = new Map();
  for (const c of chars) {
    for (const [key, n] of Object.entries(c.boss_kills || {})) {
      const [type, lv] = String(key).split("@");
      const k = type + "@" + (lv || "?");
      const cur = bossMap.get(k) || { type, name: BOSS_NAMES[type] || type, level: Number(lv) || 0, kills: 0, killers: new Set() };
      cur.kills += Number(n) || 0;
      cur.killers.add(c.user);
      bossMap.set(k, cur);
    }
  }
  const bosses = [...bossMap.values()]
    .map((b) => ({ type: b.type, name: b.name, level: b.level, kills: b.kills, players: b.killers.size }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.level - b.level);
  // v79.0: สถิติการรีเซ็ตดันเจี้ยน — ตัวเลข "เซิร์ฟเวอร์" นับเองตอนเกมยิงมาบอก (เชื่อถือได้กว่าในเซฟ)
  //         ตัวเลข "ในเซฟ" มาจากเครื่องผู้เล่น -> เอามาเทียบกัน ถ้าต่างกันมากคือน่าสงสัย
  const dgr = await dungeonStats();
  const clientResets = {};
  for (const c of chars) clientResets[c.user] = (clientResets[c.user] || 0) + (c.dungeon_resets || 0);
  const resetGaps = Object.entries(clientResets)
    .map(([user, client]) => ({ user, client, server: (dgr.per[String(user).toLowerCase()] || {}).resets || 0 }))
    .filter((x) => x.client > x.server * 1.5 + 20)
    .sort((a, b) => b.client - b.server - (a.client - a.server))
    .slice(0, 20);

  const dupMap = new Map();
  for (const r of rs) for (const [uid, who, name] of r._uids) {
    if (!dupMap.has(uid)) dupMap.set(uid, []);
    dupMap.get(uid).push({ user: r.user, where: who, name });
  }
  const dups = [...dupMap.entries()].filter(([, v]) => v.length > 1).slice(0, 100).map(([uid, v]) => ({ uid, copies: v }));
  const live = rooms.filter((r) => r.live);
  const activeIn = (ms) => rs.filter((r) => now - Math.max(r.saved_at, r.last_login) <= ms).length;
  return {
    totals: {
      accounts: rs.length,
      characters: chars.length,
      gold: chars.reduce((s, c) => s + c.gold, 0),
      avg_level: chars.length ? +(chars.reduce((s, c) => s + c.level, 0) / chars.length).toFixed(1) : 0,
      tutorial_rate: chars.length ? Math.round((chars.filter((c) => c.tutorial_done).length / chars.length) * 100) : 0,
      quests_done: chars.reduce((s, c) => s + c.quests_done, 0),
      active_15m: activeIn(15 * 60_000),
      active_24h: activeIn(DAY),
      active_7d: activeIn(7 * DAY),
      new_24h: rs.filter((r) => now - r.created <= DAY).length,
      new_7d: rs.filter((r) => now - r.created <= 7 * DAY).length,
      rooms_live: live.length,
      players_online: live.reduce((s, r) => s + (r.players || 0), 0),
      duplicate_items: dups.length,
      boss_kills: bosses.reduce((s2, b) => s2 + b.kills, 0),
      dungeon_resets: dgr.total,
      dungeon_resets_in_saves: Object.values(clientResets).reduce((a, b) => a + b, 0),
    },
    bosses,
    resets: {
      total: dgr.total,
      players: dgr.players,
      ignored: dgr.skipped,
      top_maps: dgr.top_maps.slice(0, 12),
      per: Object.entries(dgr.per)
        .map(([user, v]) => ({ user, ...v }))
        .sort((a, b) => b.resets - a.resets)
        .slice(0, 20),
      gaps: resetGaps,
    },
    signups: Object.entries(signups).map(([day, n]) => ({ day, n })),
    active: Object.entries(active).map(([day, n]) => ({ day, n })),
    levels: Object.entries(levels).map(([from, n]) => ({ range: from + "-" + (Number(from) + 4), n })).sort((a, b) => parseInt(a.range) - parseInt(b.range)),
    races,
    quests,
    top_level: [...chars].sort((a, b) => b.level - a.level || b.exp - a.exp).slice(0, 10),
    top_gold: [...chars].sort((a, b) => b.gold - a.gold).slice(0, 10),
    recent_signups: [...rs].sort((a, b) => b.created - a.created).slice(0, 8).map(publicRow),
    recent_active: [...rs].sort((a, b) => Math.max(b.saved_at, b.last_login) - Math.max(a.saved_at, a.last_login)).slice(0, 8).map(publicRow),
    duplicates: dups,
    online_by_channel: [1, 2].map((ch) => ({ channel: ch, players: live.filter((r) => r.channel === ch).reduce((s, r) => s + (r.players || 0), 0) })),
  };
}

// ---------- รายละเอียดผู้เล่น ----------
async function playerDetail(user) {
  const u = String(user || "").toLowerCase();
  if (!/^[a-z0-9]{3,16}$/.test(u)) return null;
  const a = parse(await store.get("sof:acct:" + u));
  if (!a) return null;
  const save = parse(await store.get("sof:save:" + u));
  const chars = charsOf(save, u).map((c) => ({
    summary: summarizeChar(c),
    items: itemsOfInventory(c.inventory).map((it) => ({ where: it.where, name: it.name || it.id || "?", rarity: it.rarity || "", slot: it.slot || "", uid: it.uid || "", level: it.req_level || it.level || "" })),
    quests: Object.entries(c.quests || {}).map(([id, q]) => ({ id, title: QUEST_TITLES[id] || id, state: q && q.state, done: q && q.done })),
    alloc: c.alloc || {},
    raw: c,
  }));
  const stash = stashOf(save);
  const social = socialOf(save);
  const tx = (await allTx()).filter((t) => String(t.user).toLowerCase() === u);
  return {
    account: { user: a.user, created: a.created || 0, last_login: a.lastLogin || 0, logins: a.logins || 0 },
    purchases: tx.map((t) => ({ id: t.id, sku: t.sku, name: t.name, state: t.state, amount_cents: t.amount_cents, currency: t.currency, created: t.created, paid_at: t.paid_at || 0 })),
    spent_cents: tx.filter((t) => t.state === "paid").reduce((s2, t) => s2 + (Number(t.amount_cents) || 0), 0),
    costumes_owned: await ownedOf(u),
    saved_at: save ? save.saved_at || save.t || 0 : 0,
    files: save && save.files ? Object.fromEntries(Object.entries(save.files).map(([k, v]) => [k, String(v).length])) : {},
    characters: chars,
    stash: stashItems(stash).map((it) => ({ name: it.name || it.id || "?", rarity: it.rarity || "", slot: it.slot || "", uid: it.uid || "" })),
    friends: social && Array.isArray(social.friends) ? social.friends : [],
  };
}

// ---------- v41: การเติมเงิน (ร้านคอสตูมเงินจริง) ----------
async function payments() {
  const tx = await allTx();
  const paid = tx.filter((t) => t.state === "paid");
  const sum = (a) => a.reduce((s, t) => s + (Number(t.amount_cents) || 0), 0);
  const now = Date.now();
  const dayKey = (t) => new Date(t + 7 * 3600_000).toISOString().slice(0, 10);   // วันตามเวลาไทย
  const byDay = {};
  for (let d = 29; d >= 0; d--) byDay[dayKey(now - d * DAY)] = { day: dayKey(now - d * DAY), orders: 0, cents: 0 };
  for (const t of paid) {
    const k = dayKey(t.paid_at || t.created);
    if (byDay[k]) { byDay[k].orders++; byDay[k].cents += Number(t.amount_cents) || 0; }
  }
  const bySku = {};
  for (const [sku, name] of Object.entries(CATALOG)) bySku[sku] = { sku, name, orders: 0, cents: 0 };
  for (const t of paid) if (bySku[t.sku]) { bySku[t.sku].orders++; bySku[t.sku].cents += Number(t.amount_cents) || 0; }
  const byUser = {};
  for (const t of paid) {
    const u = String(t.user || "?");
    byUser[u] ||= { user: u, orders: 0, cents: 0, last: 0 };
    byUser[u].orders++;
    byUser[u].cents += Number(t.amount_cents) || 0;
    byUser[u].last = Math.max(byUser[u].last, t.paid_at || t.created || 0);
  }
  const inRange = (ms) => paid.filter((t) => now - (t.paid_at || t.created) <= ms);
  return {
    enabled: shopEnabled(), currency: CURRENCY, price_cents: PRICE_CENTS,
    totals: {
      orders: tx.length,
      paid: paid.length,
      pending: tx.filter((t) => t.state === "pending").length,
      failed: tx.filter((t) => t.state === "failed").length,
      revenue_cents: sum(paid),
      revenue_24h_cents: sum(inRange(DAY)),
      revenue_7d_cents: sum(inRange(7 * DAY)),
      revenue_30d_cents: sum(inRange(30 * DAY)),
      paying_users: Object.keys(byUser).length,
      arppu_cents: Object.keys(byUser).length ? Math.round(sum(paid) / Object.keys(byUser).length) : 0,
    },
    by_day: Object.values(byDay),
    by_sku: Object.values(bySku).sort((a, b) => b.orders - a.orders),
    top_buyers: Object.values(byUser).sort((a, b) => b.cents - a.cents).slice(0, 20),
    recent: tx.slice(0, 100).map((t) => ({ id: t.id, user: t.user, sku: t.sku, name: t.name, state: t.state,
      amount_cents: t.amount_cents, currency: t.currency, created: t.created, paid_at: t.paid_at || 0, session: t.session || "" })),
  };
}

// ---------- ทางเข้า ----------
export async function handleAdmin(method, body, headers) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const ip = clientIp(headers || {}) || "?";
  if ((await store.hit("sof:admrate:" + ip, 60)) > 60) return [429, { ok: false, msg: "เรียกถี่เกินไป รอสักครู่" }];
  const b = body && typeof body === "object" ? body : {};
  const who = await userOf(String(b.token || ""));
  if (!who) return [401, { ok: false, msg: "ต้องล็อกอินก่อน" }];
  if (!isAdmin(who)) return [403, { ok: false, msg: "บัญชีนี้ไม่ใช่ผู้ดูแล" }];
  // v78.4: ถ้าตั้ง SOF_ADMIN_KEY ไว้ ต้องมีคีย์ผู้ดูแลมาด้วย (ล็อกอินอย่างเดียวไม่พอ)
  if (!adminKeyOk(b.key)) {
    await store.hit("sof:admkeyfail:" + ip, 3600);
    return [403, { ok: false, msg: "ต้องกรอกคีย์ผู้ดูแลให้ถูกต้อง", need_key: true }];
  }
  const action = String(b.action || "");
  if (action === "rooms") return [200, { ok: true, rooms: await allRooms(), now: Date.now() }];
  if (action === "overview") {
    const c = await rows(!!b.fresh);
    return [200, { ok: true, admin: who, storage: store.storageKind(), computed_at: c.t, now: Date.now(), ...(await overview(c.rows, await allRooms())) }];
  }
  if (action === "players") {
    const c = await rows(!!b.fresh);
    return [200, { ok: true, computed_at: c.t, now: Date.now(), players: c.rows.map(publicRow) }];
  }
  if (action === "payments") return [200, { ok: true, now: Date.now(), ...(await payments()) }];
  // v78.4: บัญชีที่ส่งเซฟซึ่งเป็นไปไม่ได้ (ด่านกันโกงปฏิเสธไว้) -> ดูได้ว่าใครพยายามโกงบ้าง
  if (action === "cheaters") {
    const keys = await store.scanPrefix("sof:cheatflag:");
    const vals = await store.mgetBatched(keys, 100);
    const list = keys.map((k, i) => ({ user: k.slice("sof:cheatflag:".length), ...(parse(vals[i]) || {}) }))
      .filter((x) => x.n).sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 200);
    // v79.2: แสดงด้วยว่าใครถูกระงับอยู่ และเพดานแบนอัตโนมัติตั้งไว้เท่าไหร่
    for (const row of list) {
      const bn = await banInfo(row.user);
      row.banned = !!bn;
      row.ban_until = bn ? bn.until || 0 : 0;
      row.ban_by = bn ? bn.by : "";
      const g = await tradeGate(row.user);
      row.restricted = !!g.restricted;
      row.can_trade = !!g.ok;
    }
    return [200, { ok: true, now: Date.now(), key_required: adminKeyRequired(), cheaters: list,
      bans: await listBans(), autoban: autoBanOn() ? autoBanFlags() : 0 }];
  }
  // v78.6: ล้างข้อมูลทั้งเซิร์ฟเวอร์ (เปิดเบต้ารอบใหม่) — ผ่านมาถึงตรงนี้ = ผ่านบัญชีผู้ดูแล + คีย์ผู้ดูแลแล้ว
  if (action === "wipe") {
    const [code, out] = await handleWipe(who, b);
    if (code === 200 && !out.dry_run) _resetCache();     // ตัวเลขในหน้าภาพรวมต้องคิดใหม่
    return [code, out];
  }
  // v79.2: แบนมือ / ปลดแบน — ผ่านมาถึงตรงนี้ = ผ่านบัญชีผู้ดูแล + คีย์ผู้ดูแลแล้ว
  if (action === "ban") {
    const target = String(b.user || "").trim();
    if (!target) return [400, { ok: false, msg: "ไม่ได้ระบุบัญชี" }];
    if (isAdmin(target)) return [400, { ok: false, msg: "แบนบัญชีผู้ดูแลไม่ได้" }];
    if (!(await store.get("sof:acct:" + target.toLowerCase()))) return [404, { ok: false, msg: "ไม่พบบัญชีนี้" }];
    const r = await ban(target, { by: who, reason: String(b.reason || "").slice(0, 200), days: Number(b.days) || 0 });
    return r.ok ? [200, { ok: true, ...r, bans: await listBans() }] : [400, r];
  }
  if (action === "unban") {
    const r = await unban(String(b.user || "").trim());
    return r.ok ? [200, { ok: true, ...r, bans: await listBans() }] : [400, r];
  }
  if (action === "bans") return [200, { ok: true, bans: await listBans(), autoban: autoBanOn() ? autoBanFlags() : 0 }];
  // v79.3: ปลด "สถานะจำกัด" (บัญชีที่สมัครจาก IP ซึ่งเพิ่งมีคนถูกแบน — เล่นได้ แต่ยังเทรดไม่ได้)
  if (action === "unrestrict") {
    const r = await unrestrict(String(b.user || "").trim());
    return r.ok ? [200, { ok: true, ...r }] : [404, r];
  }
  // v79.3: ดูว่าบัญชีนี้ผ่านด่านเทรด/คลังกิลด์แล้วหรือยัง
  if (action === "gate") {
    const target = String(b.user || "").trim();
    if (!target) return [400, { ok: false, msg: "ไม่ได้ระบุบัญชี" }];
    return [200, { ok: true, user: target, gate: await tradeGate(target),
      need_hours: minHours(), need_level: minLevel() }];
  }
  if (action === "player") {
    const d = await playerDetail(b.user);
    return d ? [200, { ok: true, now: Date.now(), ...d }] : [404, { ok: false, msg: "ไม่พบบัญชี" }];
  }
  return [400, { ok: false, msg: "action?" }];
}

export function _resetCache() { cache = null; }
