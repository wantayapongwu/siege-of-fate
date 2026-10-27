// lib/shop.js -- v41: ร้านคอสตูมด้วยเงินจริง (Stripe Checkout) ราคา 1 USD ต่อชุด
//
// หลักการความปลอดภัย (เงินจริง — ห้ามเชื่อฝั่งเกม):
//   • ราคาและรายการสินค้าอยู่ที่เซิร์ฟเวอร์เท่านั้น เกมส่งมาได้แค่ "sku"
//   • สิทธิ์ (entitlement) จะให้ก็ต่อเมื่อ Stripe ยืนยันว่าจ่ายแล้ว — จาก webhook (ลายเซ็นถูกต้อง)
//     หรือจากการถาม Stripe ตรงๆ ด้วย session id ที่เราเก็บไว้เอง (ไม่เคยเชื่อค่าที่เกมส่งมา)
//   • ทุกคำสั่งซื้อถูกบันทึกเป็นธุรกรรม (sof:tx:<id>) เก็บถาวร ดูได้ในหน้า /admin
//   • ไม่เก็บเลขบัตร/ข้อมูลการชำระเงินใดๆ บนเซิร์ฟเวอร์เรา — ทั้งหมดอยู่กับ Stripe
//   • ซื้อซ้ำชุดเดิมไม่ได้ (คืนข้อความบอกว่ามีแล้ว) และจ่ายซ้ำจาก webhook เดิมจะไม่ถูกนับซ้ำ (idempotent)
//
// POST /api/shop {action, token, ...}
//   catalog                      -> {ok, items:[{sku,name,price_cents,currency,owned}], enabled, currency}
//   owned                        -> {ok, skus:[...]}
//   start   {sku}                -> {ok, order, url}          เปิด url ให้ผู้เล่นจ่ายเงิน
//   status  {order}              -> {ok, state:"pending"|"paid"|"failed", skus:[...]}
//   history                      -> {ok, tx:[...]}            ประวัติการซื้อของบัญชีตัวเอง
import crypto from "node:crypto";
import * as store from "./store.js";
import { userOf } from "./accounts.js";
import { clientIp } from "./lobby.js";

export const CURRENCY = "usd";
export const PRICE_CENTS = 100;              // 1 USD ต่อคอสตูม 1 ชุด
const ORDER_TTL = 7 * 24 * 3600;
const SKU_RE = /^cos_skin_[a-z0-9_]{1,24}$/;

// รายการคอสตูมที่ขาย (ต้องตรงกับ GameData.SKIN_COSTUMES ฝั่งเกม — เทสต์ฝั่งเกมตรวจให้)
export const CATALOG = {
  cos_skin_ash: "ชุดเกราะเถ้าถ่าน",
  cos_skin_cosmic: "ชุดจักรวาลดารา",
  cos_skin_frost: "ชุดเกราะน้ำแข็ง",
  cos_skin_primitive: "ชุดนักรบดึกดำบรรพ์",
  cos_skin_rogue: "ชุดนักล่ากะโหลกเขา",
  cos_skin_shadow: "ชุดเงารัตติกาล",
  cos_skin_shaman: "ชุดหมอผีพงไพร",
  cos_skin_spark: "ชุดอัสนีสายฟ้า",
  cos_skin_spatun: "ชุดนักรบสปาร์ตา",
  cos_skin_void: "ชุดสุญญตา",
  cos_skin_worden: "ชุดผู้คุมกระดูก",
};

const SECRET = () => String(process.env.STRIPE_SECRET_KEY || "");
const WEBHOOK_SECRET = () => String(process.env.STRIPE_WEBHOOK_SECRET || "");
export const shopEnabled = () => !!SECRET();
const siteUrl = (headers) => {
  const env = String(process.env.SOF_SITE_URL || "").replace(/\/$/, "");
  if (env) return env;
  const h = headers || {};
  const host = String(h["x-forwarded-host"] || h.host || "");
  const proto = String(h["x-forwarded-proto"] || "https");
  return host ? proto + "://" + host : "";
};

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

// ---------- สิทธิ์คอสตูมของบัญชี ----------
export async function ownedOf(user) {
  const list = parse(await store.get("sof:ent:" + String(user).toLowerCase()));
  return Array.isArray(list) ? list.filter((s) => SKU_RE.test(String(s))) : [];
}

async function grant(user, sku) {
  const key = "sof:ent:" + String(user).toLowerCase();
  // ล็อกสั้นๆ กันให้สิทธิ์พร้อมกันสองทาง (webhook + status) แล้วเขียนทับกัน
  for (let i = 0; i < 20; i++) {
    if (await store.lock(key + ":lock", 5)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const cur = await ownedOf(user);
  if (!cur.includes(sku)) cur.push(sku);
  await store.set(key, JSON.stringify(cur));
  await store.del(key + ":lock");
  return cur;
}

// ---------- ธุรกรรม ----------
async function saveTx(tx) {
  await store.set("sof:tx:" + tx.id, JSON.stringify(tx));
  await store.sadd("sof:txs", tx.id);
}
export async function getTx(id) {
  return parse(await store.get("sof:tx:" + String(id)));
}
export async function allTx(limit = 500) {
  const ids = await store.smembers("sof:txs");
  const rows = (await store.mgetBatched(ids.slice(0, limit).map((i) => "sof:tx:" + i), 50)).map(parse).filter(Boolean);
  rows.sort((a, b) => (b.created || 0) - (a.created || 0));
  return rows;
}

// ---------- Stripe REST ----------
async function stripe(path, form) {
  const body = new URLSearchParams(form).toString();
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + SECRET(),
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
    body: form ? body : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d && d.error && d.error.message) || "stripe " + r.status);
  return d;
}
async function stripeGet(path) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    headers: { Authorization: "Bearer " + SECRET(), "Stripe-Version": "2024-06-20" },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d && d.error && d.error.message) || "stripe " + r.status);
  return d;
}

// ---------- ยืนยันการจ่ายเงินแล้วให้สิทธิ์ (ใช้ทั้ง webhook และ status) ----------
async function fulfil(tx, session) {
  if (!tx) return null;
  if (tx.state === "paid") return tx;                       // ให้สิทธิ์ไปแล้ว — ไม่นับซ้ำ
  tx.state = "paid";
  tx.paid_at = Date.now();
  tx.amount_cents = Number((session && session.amount_total) ?? tx.amount_cents) || PRICE_CENTS;
  tx.currency = String((session && session.currency) || tx.currency || CURRENCY);
  tx.payment_intent = typeof (session && session.payment_intent) === "string" ? session.payment_intent : tx.payment_intent || "";
  await grant(tx.user, tx.sku);
  await saveTx(tx);
  return tx;
}

// ---------- Webhook (Stripe -> เรา) ----------
// ตรวจลายเซ็นตามสูตรของ Stripe: t=<ts>,v1=<hmac sha256 ของ "<ts>.<raw body>">
export function verifySignature(rawBody, header, secret, nowMs = Date.now()) {
  const parts = String(header || "").split(",").reduce((o, p) => {
    const i = p.indexOf("=");
    if (i > 0) (o[p.slice(0, i).trim()] ||= []).push(p.slice(i + 1).trim());
    return o;
  }, {});
  const t = parts.t && parts.t[0];
  const sigs = parts.v1 || [];
  if (!t || !sigs.length || !secret) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > 300) return false;        // กัน replay เกิน 5 นาที
  const want = crypto.createHmac("sha256", secret).update(t + "." + rawBody).digest("hex");
  return sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

export async function handleWebhook(method, rawBody, headers) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  if (!WEBHOOK_SECRET()) return [503, { ok: false, msg: "webhook not configured" }];
  const sig = (headers || {})["stripe-signature"];
  if (!verifySignature(rawBody, sig, WEBHOOK_SECRET())) return [400, { ok: false, msg: "bad signature" }];
  const ev = parse(rawBody);
  if (!ev || typeof ev !== "object") return [400, { ok: false, msg: "bad body" }];
  const type = String(ev.type || "");
  const obj = (ev.data && ev.data.object) || {};
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    if (String(obj.payment_status || "") !== "paid") return [200, { ok: true, skipped: "unpaid" }];
    const id = String((obj.metadata && obj.metadata.order) || "");
    const tx = await getTx(id);
    if (!tx) return [200, { ok: true, skipped: "unknown order" }];
    if (String(tx.session || "") !== String(obj.id || "")) return [200, { ok: true, skipped: "session mismatch" }];
    await fulfil(tx, obj);
    return [200, { ok: true, fulfilled: tx.id }];
  }
  if (type === "checkout.session.expired" || type === "checkout.session.async_payment_failed") {
    const tx = await getTx(String((obj.metadata && obj.metadata.order) || ""));
    if (tx && tx.state === "pending") {
      tx.state = "failed";
      tx.failed_at = Date.now();
      await saveTx(tx);
    }
    return [200, { ok: true }];
  }
  return [200, { ok: true, ignored: type }];
}

// ---------- ทางเข้า ----------
export async function handleShop(method, body, headers) {
  if (method !== "POST") return [405, { ok: false, msg: "method" }];
  const ip = clientIp(headers || {}) || "?";
  if ((await store.hit("sof:shoprate:" + ip, 60)) > 60) return [429, { ok: false, msg: "เรียกถี่เกินไป รอสักครู่" }];
  const b = body && typeof body === "object" ? body : {};
  const user = await userOf(String(b.token || ""));
  if (!user) return [401, { ok: false, msg: "ต้องล็อกอินก่อนจึงจะซื้อได้" }];
  const action = String(b.action || "");
  const owned = await ownedOf(user);

  if (action === "catalog") {
    return [200, {
      ok: true, enabled: shopEnabled(), currency: CURRENCY, price_cents: PRICE_CENTS,
      items: Object.entries(CATALOG).map(([sku, name]) => ({ sku, name, price_cents: PRICE_CENTS, currency: CURRENCY, owned: owned.includes(sku) })),
    }];
  }
  if (action === "owned") return [200, { ok: true, skus: owned }];
  if (action === "history") {
    const mine = (await allTx()).filter((t) => String(t.user).toLowerCase() === user.toLowerCase());
    return [200, { ok: true, tx: mine.map((t) => ({ id: t.id, sku: t.sku, state: t.state, amount_cents: t.amount_cents, currency: t.currency, created: t.created, paid_at: t.paid_at || 0 })) }];
  }
  if (action === "start") {
    if (!shopEnabled()) return [503, { ok: false, msg: "ร้านค้ายังไม่เปิด (ผู้ดูแลยังไม่ได้ตั้งค่าการชำระเงิน)" }];
    const sku = String(b.sku || "");
    if (!CATALOG[sku]) return [400, { ok: false, msg: "ไม่มีสินค้านี้" }];
    if (owned.includes(sku)) return [409, { ok: false, msg: "คุณมีคอสตูมชุดนี้อยู่แล้ว" }];
    if ((await store.hit("sof:shopstart:" + user.toLowerCase(), 3600)) > 30) return [429, { ok: false, msg: "สั่งซื้อถี่เกินไป ลองใหม่ภายหลัง" }];
    const id = crypto.randomBytes(12).toString("hex");
    const site = siteUrl(headers);
    let session;
    try {
      session = await stripe("checkout/sessions", {
        mode: "payment",
        "payment_method_types[0]": "card",
        "line_items[0][price_data][currency]": CURRENCY,
        "line_items[0][price_data][unit_amount]": String(PRICE_CENTS),
        "line_items[0][price_data][product_data][name]": "Siege of Fate — " + CATALOG[sku],
        "line_items[0][quantity]": "1",
        "metadata[order]": id,
        "metadata[user]": user,
        "metadata[sku]": sku,
        client_reference_id: id,
        success_url: site + "/?paid=" + id,
        cancel_url: site + "/?cancel=" + id,
      });
    } catch (e) {
      return [502, { ok: false, msg: "ติดต่อระบบชำระเงินไม่ได้: " + (e && e.message) }];
    }
    const tx = {
      id, user, sku, name: CATALOG[sku], state: "pending", amount_cents: PRICE_CENTS, currency: CURRENCY,
      created: Date.now(), session: String(session.id || ""), ip,
    };
    await saveTx(tx);
    await store.setex("sof:order:" + id, ORDER_TTL, "1");
    return [200, { ok: true, order: id, url: String(session.url || "") }];
  }
  if (action === "status") {
    const tx = await getTx(String(b.order || ""));
    if (!tx || String(tx.user).toLowerCase() !== user.toLowerCase()) return [404, { ok: false, msg: "ไม่พบคำสั่งซื้อ" }];
    if (tx.state === "pending" && shopEnabled() && tx.session) {
      try {
        const s = await stripeGet("checkout/sessions/" + encodeURIComponent(tx.session));
        if (String(s.payment_status || "") === "paid") await fulfil(tx, s);
        else if (String(s.status || "") === "expired") { tx.state = "failed"; await saveTx(tx); }
      } catch { /* ถามไม่ได้ตอนนี้ = ปล่อยค้าง pending ไว้ก่อน (webhook จะตามมาเอง) */ }
    }
    return [200, { ok: true, state: tx.state, sku: tx.sku, skus: await ownedOf(user) }];
  }
  return [400, { ok: false, msg: "action?" }];
}
