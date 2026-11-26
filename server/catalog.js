// Catalog on the server: same data and search as the site, with the owner's price changes applied.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(fs.readFileSync(path.join(here, "..", "public", "catalog.json"), "utf8"));
const SYN = JSON.parse(fs.readFileSync(path.join(here, "syn.json"), "utf8"));

export const SECS = RAW.s;
export const PROMO_SEC = SECS.findIndex((s) => s.d === "promo");

export function normalize(s) {
  return String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[()\[\],]/g, " ");
}

let ITEMS = [];
let HAY = [];

export function rebuild(overrides) {
  const map = {};
  (overrides || []).forEach((o) => { if (o && o.k) map[o.k] = o; });
  ITEMS = RAW.i.map((a, ix) => {
    const it = { ix, sec: a[0], m: a[1], g: a[2], sp: a[3], d: a[4], p: a[5], op: a[6], i: a[7], rub: a[8], perM: a[9] === 1, k: SECS[a[0]].k + "|" + a[1] };
    const o = map[it.k];
    if (o) { if (o.p != null) it.p = o.p; if (o.op != null) it.op = o.op; it.hidden = !!o.hidden; }
    return it;
  });
  (overrides || []).filter((o) => o && o.add && !o.deleted).forEach((o) => {
    const sec = SECS.findIndex((x) => x.k === o.sec);
    if (sec < 0) return;
    ITEMS.push({ ix: ITEMS.length, sec, m: o.m, g: o.g || "", sp: o.sp || "", d: o.d || "", p: +o.p || 0, op: +o.op || 0, i: "", rub: 0, perM: false, k: o.k, hidden: !!o.hidden });
  });
  HAY = ITEMS.map((it) => normalize([it.m, it.g, it.sp, it.d, ...SECS[it.sec].n, SYN[SECS[it.sec].k] || "", it.rub ? "рубеж rubezh" : "hikvision"].join(" ")));
}
rebuild([]);

export const items = () => ITEMS;
export const visible = () => ITEMS.filter((i) => !i.hidden);
export const byKey = (k) => ITEMS.find((i) => i.k === k && !i.hidden);

export function search(q, pool) {
  const toks = normalize(q).split(/\s+/).filter((x) => x.length > 1);
  if (!toks.length) return pool;
  const res = [];
  for (const ix of pool) {
    const h = HAY[ix]; let sc = 0, all = true;
    for (const tk of toks) {
      const stem = tk.length > 5 ? tk.slice(0, tk.length - 2) : tk;
      if (h.includes(tk)) sc += 2; else if (h.includes(stem)) sc += 1; else all = false;
    }
    if (sc > 0) res.push([ix, sc + (all ? 5 : 0) + (normalize(ITEMS[ix].m).includes(normalize(q)) ? 10 : 0)]);
  }
  res.sort((a, b) => b[1] - a[1]);
  return res.map((r) => r[0]);
}

export function findModel(m) {
  const n = normalize(m).replace(/\s+/g, "");
  let best = ITEMS.find((it) => !it.hidden && normalize(it.m).replace(/\s+/g, "") === n);
  if (!best) { const r = search(m, visible().map((i) => i.ix)); best = r.length ? ITEMS[r[0]] : null; }
  return best;
}

export function brief(it) {
  return {
    model: it.m, section: SECS[it.sec].n[1] + " / " + SECS[it.sec].n[2], series: it.g, spec: it.sp,
    description: (it.d || "").slice(0, 140), price_amd: it.p, unit: it.perM ? "per metre" : "piece",
    old_price_amd: it.op || undefined, brand: it.rub ? "Rubezh" : "Hikvision",
  };
}

export function sectionSummary() {
  return SECS.map((s, i) => {
    const its = ITEMS.filter((x) => x.sec === i && !x.hidden);
    if (!its.length) return "";
    const ps = its.map((x) => x.p);
    return `- ${s.n[1]} / ${s.n[2]} [${s.d}]: ${its.length} items, ${Math.min(...ps)}–${Math.max(...ps)} AMD`;
  }).filter(Boolean).join("\n");
}

export function cartLines(cart) {
  return (cart || []).map((c) => ({ it: byKey(c.k), q: Math.max(0, Math.round(+c.q || 0)) })).filter((l) => l.it && l.q > 0);
}
