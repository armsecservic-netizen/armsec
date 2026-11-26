// AI consultant: Claude with tools over the catalog, the visitor's cart and the CRM.
import * as C from "./catalog.js";

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
export const aiEnabled = () => !!API_KEY;

const SERVICES = ["Купить оборудование", "Монтаж", "Проект", "Консультация", "Обслуживание"];
const LANG_NAME = { hy: "Armenian", ru: "Russian", en: "English" };

function contactLine(S) {
  return [S.phone && `Phone: ${S.phone}`, S.whatsapp && `WhatsApp: ${S.whatsapp}`, S.email && `E-mail: ${S.email}`,
    S.viber && `Viber: ${S.viber}`, S.facebook && `Facebook: ${S.facebook}`, S.instagram && `Instagram: @${String(S.instagram).replace(/^@/, "")}`, S.telegram && `Telegram/Viber: ${S.telegram}`, S.address && `Address: ${S.address}`,
    S.hours && `Hours: ${S.hours}`].filter(Boolean).join("; ");
}

export function systemPrompt({ lang, bot, settings }) {
  const B = bot || {}, faq = (B.faq || []).filter((f) => f.q && f.a);
  return `You are the online sales consultant of ArmSec (Armenian Security Service), a security systems company in Armenia that sells and installs Hikvision CCTV, intrusion alarm, access control, intercoms and network equipment, and Rubezh fire alarm systems.
Contacts: ${contactLine(settings || {}) || "not published yet — offer the request form instead"}.
Language: reply in the language of the visitor's latest message (Armenian, Russian or English). If unclear, use ${LANG_NAME[lang] || "Russian"} (the site language). In Armenian and Russian address the visitor formally (Դուք / Вы).
Who you are: ArmSec's senior sales manager and a marketer with 20 years of experience, deeply expert in security systems. Your goal is to grow ArmSec's sales by genuinely helping each visitor. You genuinely want to help people protect their home or business, and you sell excellently: you find out the real need, recommend a complete working solution, explain the benefits in plain words (what the client gets: clear picture day and night, phone access, peace of mind), suggest sensible additions honestly, answer doubts with facts, and always guide the conversation to the next step (add to cart, leave a request, call). You are warm, confident and respectful, never pushy, and you never lie or invent.${B.about ? "\n\nAbout the company (from the owner, authoritative):\n" + B.about : ""}${B.rules ? "\n\nOwner's rules for you (follow them):\n" + B.rules : ""}${faq.length ? "\n\nOwner's FAQ (use these answers first, adapt the language):\n" + faq.map((f) => "Q: " + f.q + "\nA: " + f.a).join("\n") : ""}
Rules:
- All prices come from the catalog tools: AMD, VAT included. Never invent products, prices, stock or delivery times.
- A camera alone does not work. Always build a complete, working system: cameras + a matching recorder (IP cameras → NVR, analog/Turbo HD cameras → DVR) with enough channels + a hard drive (HDD) sized for the archive + for IP: a PoE switch unless the NVR has enough PoE ports; for analog: a power supply. If the visitor asks only for cameras, politely explain what else is needed and why, and offer the full set.
- Before building a CCTV kit, if the visitor has not said it, ask in ONE short message: how many cameras, indoor/outdoor, and what else they want (alarm, intercom, access control). Do not guess the camera count.
- Build only wired, professional kits (IP cameras + NVR, or analog + DVR). Do not offer Wi-Fi/4G kits or Wi-Fi cameras unless the visitor asks for Wi-Fi or wireless.
- When the kit is agreed, call add_to_cart for every item (the site opens the cart for the visitor automatically), then make_price_list if they want a quote. In the chat text describe items in plain words ("4 outdoor 4 MP cameras, an 8-channel recorder with PoE, a 2 TB drive") with the total; do not paste long lists of model codes, the cart and the price list show them.
- Whenever you give a total or "calculate" anything, say clearly that it is the cost of equipment only: installation work, cables and mounting materials are NOT included, because every site is different, and a manager calculates them individually after clarifying the details. Do not add cables to totals or the cart unless the visitor explicitly asks for a specific cable. Then offer to leave a request so the manager can give the full price.
- Ask at most one or two short clarifying questions when needed (indoor/outdoor, wired/wireless, resolution, budget).
- Selling approach: ask about the property and the main worry first, then present a clear recommendation. When the budget is unclear, offer three tiers (Economy / Optimal / Premium) with concrete models and totals, and say which one you recommend and why. Mention promotions when they fit. Suggest useful additions (extra camera for the entrance, alarm with the cameras, UPS) honestly, never forced. Handle doubts with facts (resolution, night vision, warranty from the owner's info), never with pressure or invented claims.
- Price list: when you have agreed on a selection (or the visitor asks for a price list, quote or estimate), call make_price_list with the exact models and quantities. It shows the visitor a neat price list they can add to the cart or print. After it, always ask one short question: would they like you to open a request so a manager confirms availability and calculates installation and cables? If yes, ask for name and phone and call submit_request; the price list is attached to the request automatically.
- When the visitor wants to be contacted, ask for name and phone, then call submit_request; or call open_request_form if they prefer to fill it in.
- Promo prices are final and not subject to further discount.
- ArmSec services: site visit and design, equipment supply, installation and setup (including viewing on the phone), maintenance and expansion. Their price is quoted by a manager.
- The site has an archive calculator (section "calc") for hard drive size, and guides on IP vs analog, archive size, what a CCTV kit includes, wireless vs wired alarms.
- If the visitor is an installer, integrator, shop or developer interested in partner prices, tell them about the ArmSec partner program (partner prices, help with specifications, technical support) and call open_partner_form. Never quote partner or dealer prices yourself.
- Mention model codes exactly as in the catalog. Keep answers short and scannable: plain text, short lines, no markdown tables, no ** bold. Aim for under 120 words unless you present a price list.
- Be fast: call several tools in one round when you can (e.g. search cameras, recorders and hard drives together), and do not search more than needed.
Catalog sections:
${C.sectionSummary()}`;
}

const TOOLS = [
  { name: "search_catalog", description: "Search the ArmSec price list (Hikvision + Rubezh, prices in AMD incl. VAT). Returns up to `limit` matching products with model, section, spec, short description and price. Use English or Russian keywords, model fragments, or resolution like 4MP.",
    input_schema: { type: "object", properties: { query: { type: "string" }, domain: { type: "string", enum: ["any", "promo", "video", "net", "alarm", "fire", "access", "power"] }, max_price: { type: "number" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "get_product", description: "Full details and price of one product by exact or approximate model code.",
    input_schema: { type: "object", properties: { model: { type: "string" } }, required: ["model"] } },
  { name: "list_promotions", description: "All products currently on promotion with old and promo prices.", input_schema: { type: "object", properties: {} } },
  { name: "add_to_cart", description: "Add a product (by model code) with quantity to the visitor's cart on the site. Returns the updated cart with total. Use when the visitor agrees to a selection or asks to calculate.",
    input_schema: { type: "object", properties: { model: { type: "string" }, qty: { type: "number" } }, required: ["model", "qty"] } },
  { name: "get_cart", description: "Current cart: items, quantities, line sums and total in AMD (equipment only).", input_schema: { type: "object", properties: {} } },
  { name: "clear_cart", description: "Remove everything from the cart.", input_schema: { type: "object", properties: {} } },
  { name: "submit_request", description: "Submit a request (lead) to ArmSec managers on behalf of the visitor. Requires name and phone that the visitor gave in the chat. The current cart and this conversation are attached automatically. service index: 0 buy equipment, 1 installation, 2 design project, 3 consultation, 4 maintenance.",
    input_schema: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" }, service: { type: "number" }, comment: { type: "string" } }, required: ["name", "phone"] } },
  { name: "make_price_list", description: "Build a price list (quote) for the visitor from catalog models and quantities. Shows it in the chat as a table with total, with buttons to add everything to the cart, print or open a request. Returns the priced lines, total and any models not found.",
    input_schema: { type: "object", properties: { title: { type: "string", description: "Short title, e.g. 'CCTV for a house, 4 cameras — Optimal'" }, items: { type: "array", items: { type: "object", properties: { model: { type: "string" }, qty: { type: "number" } }, required: ["model", "qty"] } }, note: { type: "string" } }, required: ["title", "items"] } },
  { name: "open_partner_form", description: "Scroll the page to the partner program application form (for installers, integrators, shops, developers).", input_schema: { type: "object", properties: {} } },
  { name: "open_request_form", description: "Scroll the page to the request form and prefill the comment, so the visitor can fill in name and phone themselves.",
    input_schema: { type: "object", properties: { comment: { type: "string" }, service: { type: "number" } } } },
];

const MGR_EXTRA = [
  { name: "list_leads", description: "List recent requests (leads) from the CRM: id, date, name, phone, what they need, items total, status (new/work/done), source.", input_schema: { type: "object", properties: { status: { type: "string", enum: ["any", "new", "work", "done"] }, limit: { type: "number" } } } },
  { name: "set_lead_status", description: "Change a request's status and optionally add a manager note.", input_schema: { type: "object", properties: { id: { type: "number" }, status: { type: "string", enum: ["new", "work", "done"] }, note: { type: "string" } }, required: ["id"] } },
  { name: "change_price", description: "Change a product's price on the website (AMD incl. VAT). old_price makes it show as a discount; hide removes it from the site.", input_schema: { type: "object", properties: { model: { type: "string" }, price: { type: "number" }, old_price: { type: "number" }, hide: { type: "boolean" } }, required: ["model"] } },
  { name: "recent_chats", description: "Recent website conversations with the AI consultant: id, date, first question, number of messages, linked request.", input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "chat_transcript", description: "Full transcript of one website conversation by id.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];
const MGR_TOOLS = [...TOOLS.filter((t) => ["search_catalog", "get_product", "list_promotions", "make_price_list"].includes(t.name)), ...MGR_EXTRA]
  .map((t, i, arr) => (i === arr.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
export function managerPrompt({ settings }) {
  return `You are the internal assistant of ArmSec (Armenian Security Service) in Telegram. You talk to the owner and managers, not to clients.
Reply in the language of the message (Armenian, Russian or English). Be brief and practical. Plain text for Telegram, no markdown tables, no ** bold.
You can: build price lists / commercial offers for a client (make_price_list with exact catalog models and quantities; the system then sends a link to a printable price list), look up products and prices, show recent requests and website conversations, change a request status or add a note, change prices on the website.
Rules: prices are AMD incl. VAT from the catalog; installation and cables are not included in price lists. For CCTV kits include cameras + matching NVR/DVR + HDD + PoE switch or PoE recorder; wired by default. Only change prices when the message clearly asks for it, then confirm what you changed. Never invent data.
Company contacts: ${[settings?.phone, settings?.whatsapp && "WhatsApp " + settings.whatsapp, settings?.address].filter(Boolean).join("; ") || "-"}.
Catalog sections:
${C.sectionSummary()}`;
}
const TOOLS_CACHED = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
function cartObj(ctx) {
  const lines = C.cartLines(ctx.cart);
  return { items: lines.map((l) => ({ model: l.it.m, qty: l.q, price_amd: l.it.p, sum_amd: l.it.p * l.q })), total_amd: lines.reduce((s, l) => s + l.it.p * l.q, 0) };
}

async function runTool(name, inp, ctx) {
  inp = inp || {};
  switch (name) {
    case "search_catalog": {
      let pool = C.visible().map((i) => i.ix);
      const d = inp.domain && inp.domain !== "any" ? inp.domain : null;
      const all = C.items();
      if (d === "promo") pool = pool.filter((ix) => all[ix].sec === C.PROMO_SEC);
      else if (d) pool = pool.filter((ix) => C.SECS[all[ix].sec].d === d);
      let r = C.search(String(inp.query || ""), pool);
      if (inp.max_price) r = r.filter((ix) => all[ix].p <= inp.max_price);
      const lim = Math.min(Math.max(+inp.limit || 10, 1), 20);
      return { count: r.length, items: r.slice(0, lim).map((ix) => C.brief(all[ix])) };
    }
    case "get_product": {
      const it = C.findModel(String(inp.model || ""));
      return it ? { found: true, ...C.brief(it), description: it.d } : { found: false };
    }
    case "list_promotions":
      return C.visible().filter((i) => i.sec === C.PROMO_SEC).map((i) => ({ model: i.m, series: i.g, spec: i.sp, old_price_amd: i.op, promo_price_amd: i.p }));
    case "add_to_cart": {
      const it = C.findModel(String(inp.model || ""));
      if (!it) return { error: "model not found" };
      const qty = Math.max(1, Math.round(+inp.qty || 1));
      const ex = ctx.cart.find((c) => c.k === it.k);
      if (ex) ex.q += qty; else ctx.cart.push({ k: it.k, q: qty });
      ctx.actions.push({ type: "add", k: it.k, qty });
      ctx.products.add(it.k);
      return cartObj(ctx);
    }
    case "get_cart": return cartObj(ctx);
    case "clear_cart": ctx.cart = []; ctx.actions.push({ type: "clear" }); return cartObj(ctx);
    case "make_price_list": {
      const lines = [], missing = [];
      for (const x of (Array.isArray(inp.items) ? inp.items : []).slice(0, 60)) {
        const it = C.findModel(String(x.model || "")); const q = Math.max(1, Math.round(+x.qty || 1));
        if (!it) { missing.push(String(x.model || "")); continue; }
        const ex = lines.find((l) => l.k === it.k); if (ex) { ex.qty += q; ex.sum = ex.qty * ex.price; continue; }
        lines.push({ k: it.k, model: it.m, name: (it.g || C.SECS[it.sec].n[1]).slice(0, 80), qty: q, price: it.p, sum: q * it.p, unit: it.perM ? "m" : "pcs" });
        ctx.products.add(it.k);
      }
      if (!lines.length) return { error: "no valid models", not_found: missing };
      const quote = { title: String(inp.title || "").slice(0, 160), note: String(inp.note || "").slice(0, 600), lines, total: lines.reduce((s, l) => s + l.sum, 0), date: new Date().toISOString() };
      ctx.quote = quote; ctx.actions.push({ type: "quote", quote });
      return { shown_to_visitor: true, lines: lines.map((l) => ({ model: l.model, qty: l.qty, price_amd: l.price, sum_amd: l.sum })), total_amd: quote.total, not_found: missing };
    }
    case "submit_request": {
      const name = String(inp.name || "").trim().slice(0, 120), phone = String(inp.phone || "").trim().slice(0, 60);
      if (!name || !phone) return { status: "error", reason: "name_and_phone_required" };
      const c = ctx.quote && ctx.quote.lines.length ? { items: ctx.quote.lines.map((l) => ({ model: l.model, qty: l.qty, price_amd: l.price })), total_amd: ctx.quote.total } : cartObj(ctx);
      const lead = {
        name, phone, email: "", service: SERVICES[+inp.service] || SERVICES[3], object: "", way: "", city: "",
        comment: String(inp.comment || "").slice(0, 2000), items: c.items.map((x) => [x.model, x.qty, x.price_amd]), total: c.total_amd,
        lang: ctx.lang, source: "bot", quote_title: ctx.quote ? ctx.quote.title : "",
      };
      const r = await ctx.createLead(lead, ctx.chatId);
      ctx.actions.push({ type: "lead", id: r.id });
      return { status: "sent_to_managers", request_id: r.id };
    }
    case "open_partner_form": ctx.actions.push({ type: "open_partner" }); return { opened: true };
    case "open_request_form":
      ctx.actions.push({ type: "open_form", comment: String(inp.comment || "").slice(0, 1000), service: inp.service });
      return { opened: true };
    default:
      if (ctx.mgr && typeof ctx.mgr[name] === "function") return await ctx.mgr[name](inp);
      return { error: "unknown tool" };
  }
}

function cleanHistory(hist) {
  const out = [];
  for (const m of hist) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n" + m.content;
    else out.push({ role, content: m.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function restoreQuote(q) {
  if (!q || !Array.isArray(q.lines)) return null;
  const lines = q.lines.slice(0, 60).map((l) => { const it = C.byKey(String(l.k || "")); const qty = Math.max(1, Math.round(+l.qty || 1)); return it ? { k: it.k, model: it.m, name: (it.g || "").slice(0, 80), qty, price: it.p, sum: qty * it.p } : null; }).filter(Boolean);
  return lines.length ? { title: String(q.title || "").slice(0, 160), note: String(q.note || "").slice(0, 600), lines, total: lines.reduce((s, l) => s + l.sum, 0) } : null;
}
export async function chat({ hist, lang, bot, settings, cart, quote, chatId, createLead, onStatus, mode, mgr }) {
  const ctx = { cart: (cart || []).map((c) => ({ k: String(c.k), q: +c.q || 0 })), quote: restoreQuote(quote), actions: [], products: new Set(), chatId, lang, createLead };
  const messages = cleanHistory(hist);
  const system = mode === "manager" ? managerPrompt({ settings }) : systemPrompt({ lang, bot, settings });
  ctx.mgr = mgr || null;
  const toolset = mode === "manager" ? MGR_TOOLS : TOOLS_CACHED;
  for (let round = 0; round < 8; round++) {
    const res = await fetch(BASE + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], tools: toolset, messages }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    messages.push({ role: "assistant", content: data.content });
    if (data.stop_reason !== "tool_use") {
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").replace(/\*\*/g, "").trim();
      return { text, actions: ctx.actions, products: [...ctx.products] };
    }
    const results = [];
    for (const b of data.content) {
      if (b.type !== "tool_use") continue;
      let out;
      try { if (onStatus) onStatus(b.name); out = await runTool(b.name, b.input, ctx); } catch (e) { out = { error: String(e.message || e) }; }
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: "", actions: ctx.actions, products: [...ctx.products] };
}
