// ArmSec site server: public site, AI consultant, CRM (requests, conversations), admin panel API.
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import * as C from "./catalog.js";
import * as AI from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const PORT = +process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("armsec:" + ADMIN_PASSWORD).digest("hex");
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
// External CRM (leads + inbox). Override with CRM_URL / CRM_KEY variables in Railway; CRM_URL=off disables it.
const CRM_URL = (process.env.CRM_URL || "https://crma-production.up.railway.app").replace(/\/$/, "");
const CRM_KEY = process.env.CRM_KEY || "nx_8824b55e23830824507cdafe75922a1fc2c551fa8f4246b9";
const crmOn = () => CRM_URL && CRM_URL !== "off" && CRM_KEY;
async function crmPost(path, body) {
  if (!crmOn()) return;
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(CRM_URL + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: CRM_KEY, ...body }), signal: ctl.signal });
    if (!r.ok) console.error("crm", path, r.status, (await r.text().catch(() => "")).slice(0, 200));
  } catch (e) { console.error("crm", path, e.message); } finally { clearTimeout(tm); }
}
const crmMsg = (externalId, name, text) => crmPost("/api/public/message", { channel: "website", externalId: String(externalId), name: name || "Посетитель сайта", text: String(text).slice(0, 4000), aiReply: false });

if (!ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is not set: the admin panel is locked until you set it.");
if (!AI.aiEnabled()) console.warn("ANTHROPIC_API_KEY is not set: the consultant works in quick-search mode only.");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});
app.use("/api", express.json({ limit: "300kb" }));

// ---------- helpers ----------
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); res.status(500).json({ error: "server_error" }); });
const str = (v, n) => String(v ?? "").slice(0, n);
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const b = buckets.get(key) || []; const fresh = b.filter((t) => now - t < windowMs);
  fresh.push(now); buckets.set(key, fresh); return fresh.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600e3)) buckets.delete(k); }, 600e3).unref();

function sign(v) { return crypto.createHmac("sha256", SECRET).update(v).digest("hex"); }
function cookies(req) { const o = {}; (req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const c = cookies(req).as_admin; if (!c) return false;
  const [exp, sig] = c.split("."); if (!exp || !sig || +exp < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const admin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: "login_required" }));

const TG_API = (process.env.TG_API || "https://api.telegram.org").replace(/\/$/, "");
const TG_CHATS = (process.env.TG_CHATS || "all").toLowerCase(); // all | first | off — forwarding of website conversations
const SITE_URL = (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "")).replace(/\/$/, "");
async function tgSend(chatId, text) {
  if (!TG_TOKEN || !chatId) return;
  for (let i = 0; i < text.length; i += 3900) {
    try {
      await fetch(`${TG_API}/bot${TG_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: text.slice(i, i + 3900), disable_web_page_preview: true }) });
    } catch (e) { console.error("telegram", e.message); }
  }
}
const tg = (text) => (TG_CHAT ? tgSend(TG_CHAT, text) : undefined);
const fmt = (n) => Math.round(+n || 0).toLocaleString("ru-RU").replace(/ /g, " ") + " ֏";
async function createLead(data, chatId) {
  const r = await db.createLead(data, chatId);
  const lines = [`🔔 ${data.type === "partner" ? "Заявка на партнёрство" : "Новая заявка"} №${r.id} (${data.source === "bot" ? "от консультанта" : data.source === "quiz" ? "из быстрого опроса" : "с сайта"})`, `Имя: ${data.name}`, `Телефон: ${data.phone}`,
    data.company && `Компания: ${data.company}${data.kind ? " (" + data.kind + ")" : ""}`,
    data.email && `E-mail: ${data.email}`, data.service && `Нужно: ${data.service}`, data.object && `Объект: ${data.object}`, data.way && `Связь: ${data.way}`,
    data.city && `Город: ${data.city}`, data.comment && `Комментарий: ${data.comment}`,
    (data.items || []).length ? "\n" + data.items.map(([m, q, p]) => `${m} × ${q} = ${fmt(p * q)}`).join("\n") + `\nИтого: ${fmt(data.total)} (без монтажа и кабелей)` : ""].filter(Boolean);
  tg(lines.join("\n") + (SITE_URL ? `\n\nПанель: ${SITE_URL}/admin` : "") + (chatId ? `\nПереписка: /chat_${chatId}` : ""));
  const contact = [data.phone, data.email].filter(Boolean).join(", ");
  crmPost("/api/public/lead", { name: data.name + (data.company ? ` (${data.company})` : ""), contact }).then(() => crmMsg(chatId || data.phone || "lead-" + r.id, data.name, lines.join("\n")));
  return r;
}

let OVR = [], SETTINGS = {}, BOT = {}, PROJECTS = [], ARTICLES = null;
async function loadState() {
  OVR = await db.kvGet("overrides", []); SETTINGS = await db.kvGet("settings", { phone: "+374 77 336996", whatsapp: "+374 77 336996", viber: "+374 77 336996", facebook: "https://www.facebook.com/profile.php?id=100083264440931", instagram: "armsec777", address: "Սևանի փողոց 15" }); BOT = await db.kvGet("bot", {}); PROJECTS = await db.kvGet("projects", []); ARTICLES = await db.kvGet("articles", null);
  C.rebuild(OVR);
}

// ---------- public API ----------
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/api/public", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ overrides: OVR, settings: SETTINGS, projects: PROJECTS, articles: ARTICLES, bot: { greet: BOT.greet || {}, auto: BOT.auto !== false, faq: BOT.faq || [] }, ai: AI.aiEnabled(), admin: isAdmin(req) });
});

function cleanLead(L) {
  const items = Array.isArray(L.items) ? L.items.slice(0, 100).map((x) => [str(x[0], 120), Math.max(0, Math.round(+x[1] || 0)), Math.max(0, Math.round(+x[2] || 0))]) : [];
  return {
    name: str(L.name, 120).trim(), phone: str(L.phone, 60).trim(), email: str(L.email, 160).trim(), service: str(L.service, 300), object: str(L.object, 120),
    way: str(L.way, 60), city: str(L.city, 120), comment: str(L.comment, 3000), items, total: items.reduce((s, x) => s + x[1] * x[2], 0),
    lang: str(L.lang, 4), source: L.source === "quiz" ? "quiz" : "form",
    type: L.type === "partner" ? "partner" : "client", company: str(L.company, 200).trim(), kind: str(L.kind, 60),
  };
}
app.post("/api/leads", wrap(async (req, res) => {
  if (limited("lead:" + req.ip, 8, 600e3)) return res.status(429).json({ error: "too_many" });
  const L = cleanLead(req.body?.lead || {});
  if (!L.name || !L.phone) return res.status(400).json({ error: "name_and_phone_required" });
  const chatId = req.body?.chatId ? str(req.body.chatId, 64) : null;
  let link = null;
  if (chatId) { const r = await db.pool.query("SELECT 1 FROM chats WHERE id=$1", [chatId]); if (r.rows.length) link = chatId; }
  const r = await createLead(L, link);
  res.json({ ok: true, id: r.id });
}));

function newId() { return crypto.randomBytes(12).toString("base64url"); }

app.post("/api/chat", wrap(async (req, res) => {
  if (limited("chat:" + req.ip, 40, 600e3)) return res.status(429).json({ error: "too_many" });
  const message = str(req.body?.message, 2000).trim();
  if (!message) return res.status(400).json({ error: "empty" });
  const lang = ["hy", "ru", "en"].includes(req.body?.lang) ? req.body.lang : "ru";
  let chatId = req.body?.chatId ? str(req.body.chatId, 64) : "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(chatId)) chatId = newId();
  await db.touchChat({ id: chatId, visitor: str(req.body?.visitor, 64), lang, ip: req.ip, page: str(req.headers.referer, 300) });
  const isNew = (await db.pool.query("SELECT msg_count FROM chats WHERE id=$1", [chatId])).rows[0]?.msg_count === 0;
  await db.addMessage(chatId, "user", message);
  crmMsg(chatId, "", message);
  if (isNew && TG_CHATS === "first") tg(`💬 Новый диалог с консультантом (${lang.toUpperCase()})\n👤 ${message.slice(0, 500)}\nВся переписка: /chat_${chatId}`);
  if (!AI.aiEnabled()) return res.status(503).json({ error: "ai_disabled", chatId });
  const hist = await db.history(chatId, 24);
  const cart = Array.isArray(req.body?.cart) ? req.body.cart.slice(0, 100) : [];
  try {
    const quote = req.body?.quote && typeof req.body.quote === "object" ? req.body.quote : null;
    const stream = req.query.stream === "1";
    if (stream) { res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" }); res.write(`data: ${JSON.stringify({ type: "start", chatId })}\n\n`); }
    const onStatus = stream ? (tool) => res.write(`data: ${JSON.stringify({ type: "status", tool })}\n\n`) : null;
    let out;
    try { out = await AI.chat({ hist, lang, bot: BOT, settings: SETTINGS, cart, quote, chatId, createLead, onStatus }); }
    catch (e) { if (stream) { console.error(e.message); res.write(`data: ${JSON.stringify({ type: "error", chatId })}\n\n`); return res.end(); } throw e; }
    const text = out.text || "…";
    await db.addMessage(chatId, "assistant", text, { actions: out.actions, products: out.products });
    crmMsg(chatId, "", "🤖 Консультант ArmSec:\n" + text);
    if (TG_CHATS === "all") tg(`💬 Диалог /chat_${chatId}${isNew ? " (новый)" : ""} · ${lang.toUpperCase()}\n👤 ${message.slice(0, 800)}\n\n🤖 ${text.slice(0, 2500)}`);
    if (stream) { res.write(`data: ${JSON.stringify({ type: "done", chatId, text, actions: out.actions, products: out.products })}\n\n`); return res.end(); }
    res.json({ chatId, text, actions: out.actions, products: out.products });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: "ai_failed", chatId });
  }
}));

// Messages answered in quick-search mode (no AI) are logged too, so the CRM sees every conversation.
app.post("/api/chat/log", wrap(async (req, res) => {
  if (limited("log:" + req.ip, 80, 600e3)) return res.status(429).json({ error: "too_many" });
  const lang = ["hy", "ru", "en"].includes(req.body?.lang) ? req.body.lang : "ru";
  let chatId = req.body?.chatId ? str(req.body.chatId, 64) : "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(chatId)) chatId = newId();
  await db.touchChat({ id: chatId, visitor: str(req.body?.visitor, 64), lang, ip: req.ip, page: str(req.headers.referer, 300) });
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(0, 10) : [];
  for (const m of msgs) {
    const content = str(m.content, 3000).trim(); if (!content) continue;
    await db.addMessage(chatId, m.role === "user" ? "user" : "assistant", content, { mode: "quick" });
    crmMsg(chatId, "", (m.role === "user" ? "" : "🤖 Консультант ArmSec:\n") + content);
  }
  res.json({ chatId });
}));

app.get("/uploads/:id", wrap(async (req, res) => {
  const r = await db.pool.query("SELECT mime, data FROM uploads WHERE id=$1", [str(req.params.id, 64)]);
  if (!r.rows.length) return res.status(404).end();
  res.setHeader("Content-Type", r.rows[0].mime); res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.end(r.rows[0].data);
}));

// ---------- admin API ----------
app.post("/api/admin/login", wrap(async (req, res) => {
  if (limited("login:" + req.ip, 10, 900e3)) return res.status(429).json({ error: "too_many" });
  const pw = String(req.body?.password || "");
  const a = Buffer.from(crypto.createHash("sha256").update(pw).digest("hex")), b = Buffer.from(crypto.createHash("sha256").update(ADMIN_PASSWORD).digest("hex"));
  if (!ADMIN_PASSWORD || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "wrong_password" });
  const exp = String(Date.now() + 30 * 864e5);
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `as_admin=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
  res.json({ ok: true });
}));
app.post("/api/admin/logout", (req, res) => { res.setHeader("Set-Cookie", "as_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"); res.json({ ok: true }); });
app.get("/api/admin/me", (req, res) => res.json({ admin: isAdmin(req), passwordSet: !!ADMIN_PASSWORD, ai: AI.aiEnabled(), telegram: !!(TG_TOKEN && TG_CHAT) }));

app.get("/api/admin/leads", admin, wrap(async (req, res) => {
  const r = await db.pool.query("SELECT id, data, status, note, chat_id, created FROM leads ORDER BY id DESC LIMIT 1000");
  res.json(r.rows);
}));
app.patch("/api/admin/leads/:id", admin, wrap(async (req, res) => {
  const sets = [], vals = [];
  if (["new", "work", "done"].includes(req.body?.status)) { vals.push(req.body.status); sets.push(`status=$${vals.length}`); }
  if (typeof req.body?.note === "string") { vals.push(str(req.body.note, 4000)); sets.push(`note=$${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: "nothing" });
  vals.push(+req.params.id);
  await db.pool.query(`UPDATE leads SET ${sets.join(",")}, updated=now() WHERE id=$${vals.length}`, vals);
  res.json({ ok: true });
}));
app.delete("/api/admin/leads/:id", admin, wrap(async (req, res) => { await db.pool.query("DELETE FROM leads WHERE id=$1", [+req.params.id]); res.json({ ok: true }); }));
app.get("/api/admin/leads.csv", admin, wrap(async (req, res) => {
  const r = await db.pool.query("SELECT id, data, status, note, created FROM leads ORDER BY id DESC");
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["id", "date", "name", "phone", "email", "service", "object", "contact", "city", "comment", "items", "total", "status", "note", "source"].join(",")]
    .concat(r.rows.map((x) => { const L = x.data; return [x.id, new Date(x.created).toISOString(), L.name, L.phone, L.email, L.service, L.object, L.way, L.city, L.comment, (L.items || []).map(([m, c]) => m + " x" + c).join("; "), L.total, x.status, x.note, L.source].map(q).join(","); }));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="armsec-leads.csv"');
  res.end("﻿" + rows.join("\n"));
}));

app.get("/api/admin/chats", admin, wrap(async (req, res) => {
  const r = await db.pool.query(`
    SELECT c.id, c.lang, c.lead_id, c.msg_count, c.created, c.updated,
      (SELECT content FROM messages m WHERE m.chat_id=c.id AND m.role='user' ORDER BY id LIMIT 1) AS first
    FROM chats c ORDER BY c.updated DESC LIMIT 500`);
  res.json(r.rows);
}));
app.get("/api/admin/chats/:id", admin, wrap(async (req, res) => {
  const c = await db.pool.query("SELECT id, lang, lead_id, ip, page, created FROM chats WHERE id=$1", [str(req.params.id, 64)]);
  if (!c.rows.length) return res.status(404).json({ error: "not_found" });
  const m = await db.pool.query("SELECT role, content, meta, created FROM messages WHERE chat_id=$1 ORDER BY id", [c.rows[0].id]);
  res.json({ chat: c.rows[0], messages: m.rows });
}));
app.delete("/api/admin/chats/:id", admin, wrap(async (req, res) => { await db.pool.query("DELETE FROM chats WHERE id=$1", [str(req.params.id, 64)]); res.json({ ok: true }); }));

app.get("/api/admin/bot", admin, (req, res) => res.json(BOT));
app.put("/api/admin/bot", admin, wrap(async (req, res) => {
  const b = req.body || {};
  const v = {
    greet: { hy: str(b.greet?.hy, 1500), ru: str(b.greet?.ru, 1500), en: str(b.greet?.en, 1500) }, auto: b.auto !== false,
    about: str(b.about, 12000), rules: str(b.rules, 8000),
    faq: (Array.isArray(b.faq) ? b.faq : []).slice(0, 200).map((f) => ({ q: str(f.q, 500).trim(), a: str(f.a, 3000).trim() })).filter((f) => f.q && f.a),
  };
  await db.kvSet("bot", v); BOT = v; res.json({ ok: true });
}));
app.put("/api/admin/projects", admin, wrap(async (req, res) => {
  const list = (Array.isArray(req.body?.list) ? req.body.list : []).slice(0, 200)
    .map((x) => ({ title: str(x.title, 200).trim(), type: str(x.type, 100).trim(), desc: str(x.desc, 2000).trim(), img: /^\/uploads\/[a-f0-9]+$/.test(x.img || "") ? x.img : "" }))
    .filter((x) => x.title);
  await db.kvSet("projects", list); PROJECTS = list; res.json({ ok: true });
}));
app.put("/api/admin/articles", admin, wrap(async (req, res) => {
  const L3 = (o) => ({ hy: str(o?.hy, 20000), ru: str(o?.ru, 20000), en: str(o?.en, 20000) });
  const list = (Array.isArray(req.body?.list) ? req.body.list : []).slice(0, 100)
    .map((a) => ({ id: str(a.id, 60) || crypto.randomBytes(4).toString("hex"), title: L3(a.title), body: L3(a.body) }))
    .filter((a) => a.title.ru || a.title.hy || a.title.en);
  await db.kvSet("articles", list); ARTICLES = list; res.json({ ok: true });
}));
// Download a product photo from a link (e.g. the manufacturer's product page image) and store it.
app.post("/api/admin/fetch-image", admin, wrap(async (req, res) => {
  let u; try { u = new URL(String(req.body?.url || "")); } catch { return res.status(400).json({ error: "bad_url" }); }
  if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[|::1)/i.test(u.hostname) || /\.(internal|local)$/i.test(u.hostname))
    return res.status(400).json({ error: "bad_url" });
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
  let r; try { r = await fetch(u, { signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 ArmSec-catalog" }, redirect: "follow" }); } catch { clearTimeout(tm); return res.status(400).json({ error: "fetch_failed" }); }
  clearTimeout(tm);
  const type = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (!r.ok || !["image/jpeg", "image/png", "image/webp"].includes(type)) return res.status(400).json({ error: "not_image" });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > 8e6) return res.status(400).json({ error: "too_big" });
  const id = crypto.randomBytes(10).toString("hex");
  await db.pool.query("INSERT INTO uploads(id,mime,data) VALUES($1,$2,$3)", [id, type, buf]);
  res.json({ url: "/uploads/" + id });
}));
app.put("/api/admin/settings", admin, wrap(async (req, res) => {
  const b = req.body || {}, v = {};
  ["phone", "whatsapp", "viber", "email", "facebook", "instagram", "telegram", "hours", "address"].forEach((k) => (v[k] = str(b[k], 300).trim()));
  await db.kvSet("settings", v); SETTINGS = v; res.json({ ok: true });
}));
app.put("/api/admin/overrides", admin, wrap(async (req, res) => {
  const list = (Array.isArray(req.body?.list) ? req.body.list : []).slice(0, 5000).map((o) => {
    const x = { k: str(o.k, 300) };
    if (o.add) Object.assign(x, { add: true, sec: str(o.sec, 80), m: str(o.m, 200), d: str(o.d, 2000), g: str(o.g, 200), sp: str(o.sp, 100) });
    if (o.p != null) x.p = Math.max(0, Math.round(+o.p || 0));
    if (o.op != null) x.op = Math.max(0, Math.round(+o.op || 0));
    if (o.img) x.img = str(o.img, 300);
    if (o.hidden) x.hidden = true;
    return x;
  }).filter((o) => o.k);
  await db.kvSet("overrides", list); OVR = list; C.rebuild(OVR); res.json({ ok: true });
}));
app.post("/api/admin/upload", admin, express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "6mb" }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "bad_image" });
  const id = crypto.randomBytes(10).toString("hex");
  await db.pool.query("INSERT INTO uploads(id,mime,data) VALUES($1,$2,$3)", [id, req.headers["content-type"], req.body]);
  res.json({ url: "/uploads/" + id });
}));


await db.migrate();
// ---------- Telegram assistant for the owner/managers ----------
const TG_SECRET = sign("telegram-webhook").slice(0, 32);
const tgMgr = {
  async list_leads(inp) {
    const st = ["new", "work", "done"].includes(inp.status) ? inp.status : null, lim = Math.min(Math.max(+inp.limit || 10, 1), 30);
    const r = await db.pool.query(`SELECT id, data, status, note, created FROM leads ${st ? "WHERE status=$2" : ""} ORDER BY id DESC LIMIT $1`, st ? [lim, st] : [lim]);
    return r.rows.map((x) => ({ id: x.id, date: x.created, name: x.data.name, phone: x.data.phone, need: x.data.service, comment: (x.data.comment || "").slice(0, 200), total: x.data.total, status: x.status, note: x.note, source: x.data.source }));
  },
  async set_lead_status(inp) {
    const sets = [], vals = [];
    if (["new", "work", "done"].includes(inp.status)) { vals.push(inp.status); sets.push(`status=$${vals.length}`); }
    if (typeof inp.note === "string") { vals.push(str(inp.note, 2000)); sets.push(`note=$${vals.length}`); }
    if (!sets.length) return { error: "nothing to change" };
    vals.push(+inp.id); const r = await db.pool.query(`UPDATE leads SET ${sets.join(",")}, updated=now() WHERE id=$${vals.length}`, vals);
    return { updated: r.rowCount };
  },
  async change_price(inp) {
    const it = C.findModel(String(inp.model || "")); if (!it) return { error: "model not found" };
    const list = OVR.filter((o) => o.k !== it.k), old = OVR.find((o) => o.k === it.k) || {};
    const o = { ...old, k: it.k }; if (inp.price) o.p = Math.max(0, Math.round(+inp.price)); if (inp.old_price != null) o.op = Math.max(0, Math.round(+inp.old_price)); if (inp.hide != null) o.hidden = !!inp.hide;
    list.push(o); await db.kvSet("overrides", list); OVR = list; C.rebuild(OVR);
    const now = C.findModel(it.m); return { model: it.m, price_amd: now ? now.p : o.p, old_price_amd: o.op || 0, hidden: !!o.hidden };
  },
  async recent_chats(inp) {
    const r = await db.pool.query(`SELECT c.id, c.lang, c.lead_id, c.msg_count, c.updated, (SELECT content FROM messages m WHERE m.chat_id=c.id AND m.role='user' ORDER BY id LIMIT 1) AS first FROM chats c WHERE c.id NOT LIKE 'tg-%' ORDER BY c.updated DESC LIMIT $1`, [Math.min(Math.max(+inp.limit || 10, 1), 30)]);
    return r.rows;
  },
  async chat_transcript(inp) {
    const r = await db.pool.query("SELECT role, content, created FROM messages WHERE chat_id=$1 ORDER BY id LIMIT 80", [str(inp.id, 64)]);
    return r.rows.map((m) => ({ who: m.role === "user" ? "visitor" : "assistant", text: m.content.slice(0, 1500), at: m.created }));
  },
};
async function saveQuote(q) {
  const id = crypto.randomBytes(6).toString("base64url");
  await db.kvSet("q:" + id, { ...q, created: new Date().toISOString() });
  return id;
}
async function transcriptText(id) {
  const r = await db.pool.query("SELECT role, content FROM messages WHERE chat_id=$1 ORDER BY id LIMIT 60", [id]);
  return r.rows.length ? r.rows.map((m) => (m.role === "user" ? "👤 " : "🤖 ") + m.content).join("\n\n") : "Переписка не найдена.";
}
app.post("/tg/webhook/:secret", express.json({ limit: "200kb" }), wrap(async (req, res) => {
  res.json({ ok: true });
  if (req.params.secret !== TG_SECRET) return;
  const m = req.body?.message; if (!m || !m.chat) return;
  const from = String(m.chat.id), text = String(m.text || m.caption || "").trim();
  const allowed = TG_CHAT.split(",").map((x) => x.trim()).filter(Boolean);
  if (!allowed.includes(from)) { await tgSend(from, `Этот бот работает только для команды ARM-SEC.\nВаш chat id: ${from} — добавьте его в TELEGRAM_CHAT_ID в Railway, чтобы получить доступ.`); return; }
  if (!text) return;
  if (/^\/(start|help)/.test(text)) return tgSend(from, "Я помощник ARM-SEC.\n\nПишите обычным текстом, например:\n• Составь прайс на 8 камер 4 Мп для склада\n• Покажи новые заявки\n• Заявку 15 в работу, клиент ждёт звонка завтра\n• Поставь цену DS-2CD1043G2-LIU 28000\n• Последние диалоги на сайте\n\nКоманды: /leads — новые заявки, /chats — последние диалоги, /chat_ID — переписка" + (SITE_URL ? `\nПанель управления: ${SITE_URL}/admin` : ""));
  if (/^\/leads/.test(text)) { const L = await tgMgr.list_leads({ status: "new", limit: 10 }); return tgSend(from, L.length ? L.map((x) => `№${x.id} · ${x.name} · ${x.phone}\n${x.need || ""}${x.total ? " · " + fmt(x.total) : ""}`).join("\n\n") : "Новых заявок нет."); }
  if (/^\/chats/.test(text)) { const L = await tgMgr.recent_chats({ limit: 10 }); return tgSend(from, L.length ? L.map((x) => `/chat_${x.id} · ${x.msg_count} сообщ.${x.lead_id ? " · заявка №" + x.lead_id : ""}\n${(x.first || "").slice(0, 120)}`).join("\n\n") : "Диалогов пока нет."); }
  const cm = text.match(/^\/chat_([A-Za-z0-9_-]{6,64})/); if (cm) return tgSend(from, await transcriptText(cm[1]));
  if (!AI.aiEnabled()) return tgSend(from, "AI не подключён: добавьте ANTHROPIC_API_KEY в Railway. Команды /leads и /chats работают и без него.");
  const cid = "tg-" + from;
  await db.touchChat({ id: cid, visitor: "telegram", lang: "tg", ip: "", page: "telegram" });
  await db.addMessage(cid, "user", text);
  try {
    const out = await AI.chat({ hist: await db.history(cid, 20), lang: "ru", bot: BOT, settings: SETTINGS, cart: [], quote: null, chatId: cid, createLead, mode: "manager", mgr: tgMgr });
    let reply = out.text || "Готово.";
    const q = out.actions.find((a) => a.type === "quote");
    if (q) { const id = await saveQuote(q.quote); reply += `\n\n📋 Прайс-лист: ${SITE_URL ? SITE_URL + "/q/" + id : "/q/" + id}\n(ссылку можно отправить клиенту, там же печать / PDF)`; }
    await db.addMessage(cid, "assistant", reply);
    await tgSend(from, reply);
  } catch (e) { console.error("tg ai", e.message); await tgSend(from, "Не получилось ответить, попробуйте ещё раз."); }
}));
// Printable price list page (links sent from Telegram)
app.get("/q/:id", wrap(async (req, res) => {
  const q = await db.kvGet("q:" + str(req.params.id, 20), null);
  if (!q) return res.status(404).send("Not found");
  const e = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const S = SETTINGS, d = new Date(q.created || Date.now()).toLocaleDateString("ru-RU");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARM-SEC · ${e(q.title || "Прайс-лист")}</title>
<style>body{font:15px/1.5 Arial,"Noto Sans Armenian",sans-serif;color:#0b1a30;margin:0;background:#eef2f8}.p{max-width:860px;margin:24px auto;background:#fff;border-radius:14px;padding:32px;box-shadow:0 10px 30px rgba(0,0,0,.08)}h1{font-size:24px;margin:0;letter-spacing:.06em}h1 b{color:#1662d6}.top{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #1662d6;padding-bottom:14px;flex-wrap:wrap}h2{font-size:18px;margin:20px 0 8px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #dde3ea;padding:9px 6px;text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;color:#5a6774}.n{text-align:right;white-space:nowrap}.tot td{font-weight:700;font-size:18px;border:0}.note{color:#5a6774;font-size:13px;margin-top:14px}.btn{display:inline-block;margin-top:18px;background:#1662d6;color:#fff;border:0;border-radius:10px;padding:11px 18px;font-weight:700;font-size:15px;cursor:pointer;text-decoration:none}@media print{body{background:#fff}.p{box-shadow:none;margin:0}.btn{display:none}}</style></head><body><div class="p">
<div class="top"><div><h1>ARM-<b>SEC</b></h1><div>Armenian Security Service</div></div><div style="text-align:right">${[S.phone, S.whatsapp && "WhatsApp " + S.whatsapp, S.email, S.address].filter(Boolean).map(e).join("<br>")}<br>${e(d)}</div></div>
<h2>${e(q.title || "Прайс-лист")}</h2><table><tr><th>№</th><th>Модель</th><th class="n">Цена, ֏</th><th class="n">Кол-во</th><th class="n">Сумма, ֏</th></tr>
${(q.lines || []).map((l, i) => `<tr><td>${i + 1}</td><td><b>${e(l.model)}</b><br><span style="color:#5a6774">${e(l.name || "")}</span></td><td class="n">${fmt(l.price)}</td><td class="n">${e(l.qty)}</td><td class="n">${fmt(l.sum)}</td></tr>`).join("")}
<tr class="tot"><td></td><td>Итого</td><td></td><td></td><td class="n">${fmt(q.total)}</td></tr></table>
<div class="note">Цены с НДС. Монтажные работы и кабели не входят, их рассчитывает менеджер. Предложение действительно при наличии товара на складе.${q.note ? "<br>" + e(q.note) : ""}</div>
<button class="btn" onclick="print()">Печать / PDF</button></div></body></html>`);
}));
async function setupTelegram() {
  if (!TG_TOKEN || !SITE_URL) { if (TG_TOKEN) console.warn("Telegram: set PUBLIC_URL (or generate a Railway domain) to enable the Telegram assistant."); return; }
  try {
    const r = await fetch(`${TG_API}/bot${TG_TOKEN}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `${SITE_URL}/tg/webhook/${TG_SECRET}`, allowed_updates: ["message"] }) });
    console.log("Telegram webhook:", (await r.json()).description || r.status);
  } catch (e) { console.error("Telegram webhook", e.message); }
}

// ---------- static site ----------
// Product photos are bundled in a few JSON files (server/photos-*.json) so the project stays small in file count.
const IMAGES = new Map();
for (const f of fs.readdirSync(here).filter((n) => /^photos-\d+\.json$/.test(n))) {
  for (const [h, b64] of Object.entries(JSON.parse(fs.readFileSync(path.join(here, f), "utf8")))) IMAGES.set(h, Buffer.from(b64, "base64"));
}
console.log(`Loaded ${IMAGES.size} product photos`);
app.get("/img/:file", (req, res) => {
  const buf = IMAGES.get(String(req.params.file).replace(/\.webp$/, ""));
  if (!buf) return res.status(404).end();
  res.setHeader("Content-Type", "image/webp"); res.setHeader("Cache-Control", "public, max-age=2592000, immutable"); res.end(buf);
});
app.use(express.static(PUBLIC, { index: false, maxAge: "1h" }));
const sendIndex = (req, res) => { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(PUBLIC, "index.html")); };
app.get(["/", "/admin"], sendIndex);
app.use((req, res) => (req.path.startsWith("/api/") ? res.status(404).json({ error: "not_found" }) : sendIndex(req, res)));

await loadState();
setupTelegram();
app.listen(PORT, () => console.log(`ArmSec is running on port ${PORT}`));
