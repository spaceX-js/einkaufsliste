// Angebote aus Prospekten (inoffiziell über marktguru.de – nur private Nutzung).
// Die Schlüssel stehen öffentlich im HTML der marktguru-Startseite; sie werden in settings zwischengespeichert.
//
// Ablauf: Der Cron (alle 5 Minuten) prüft jeweils ein paar Artikel – offene Sachen der Liste und Artikel
// mit Preisalarm. Gefundene Angebote landen in der Tabelle offers (alte bleiben für den Preisverlauf).
// Bei Preisalarm gibt es eine Nachricht aufs Handy.

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
export const DEFAULT_CONFIG = { zip: "50354", shops: [], zipByShop: {}, rules: { bioFirst: true, ownBrandOk: true } };
const RECHECK_MS = 8 * 3600 * 1000;      // jeden Artikel höchstens alle 8 Stunden neu prüfen
const PER_RUN = 6;                         // Artikel pro Cron-Lauf (je 1–2 Anfragen)

export async function marktguruKeys(env, force = false) {
  if (!force) {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'mg_keys'").first();
    if (row) { try { const k = JSON.parse(row.value); if (k.apiKey && k.clientKey) return k; } catch (e) {} }
  }
  const res = await (env.OFFERS_FETCH || fetch)("https://www.marktguru.de/", { headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "de-DE" } });
  const html = await res.text();
  const re = /<script\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let m, keys = null;
  while ((m = re.exec(html)) !== null) {
    try { const cfg = JSON.parse(m[1]); const c = cfg.config || cfg; if (c && c.apiKey && c.clientKey) keys = { apiKey: c.apiKey, clientKey: c.clientKey }; } catch (e) {}
  }
  if (!keys) throw new Error("marktguru: keine Schlüssel gefunden (HTTP " + res.status + ")");
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('mg_keys', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(keys)).run();
  return keys;
}

export async function searchOffers(env, q, zipCode, limit = 60) {
  const f = env.OFFERS_FETCH || fetch;
  let keys = await marktguruKeys(env);
  const url = "https://api.marktguru.de/api/v1/offers/search?" + new URLSearchParams({ as: "web", q, zipCode: String(zipCode), limit: String(limit), offset: "0" });
  const get = k => f(url, { headers: { "x-apikey": k.apiKey, "x-clientkey": k.clientKey, "User-Agent": UA, "Accept": "application/json", "Origin": "https://www.marktguru.de", "Referer": "https://www.marktguru.de/" } });
  let res = await get(keys);
  if (res.status === 401 || res.status === 403) { keys = await marktguruKeys(env, true); res = await get(keys); }
  const text = await res.text();
  if (!res.ok) throw new Error("marktguru: HTTP " + res.status + " " + text.slice(0, 200));
  const data = JSON.parse(text);
  return Array.isArray(data.results) ? data.results : [];
}

/* ---------- Text-Vergleich (wie bei den Kassenzetteln) ---------- */
export function fold(s) { return String(s || "").toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss").replace(/([^aeiou])(ae|oe|ue)/g, (m, a, b) => a + b[0]); }
const FILL = new Set(["klein", "kleine", "kleiner", "kleines", "gross", "grosse", "neu", "neue", "neuer", "neues", "normal", "normale", "papa", "mama", "bio", "tk", "von", "fur", "mit", "und", "fuer", "edelstes", "geiles", "frisch", "frische", "lose"]);
function words(s) { return fold(s).replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length >= 3 && !/^\d/.test(w)); }
// Suchbegriff aus dem Artikelnamen: „Kleine Cola Dosen“ → „Cola Dosen“, „TK Erbsen“ → „Erbsen“
export function queryFor(name) {
  const w = String(name || "").split(/\s+/).filter(x => x && !FILL.has(fold(x).replace(/[^a-z]/g, "")) && x.length >= 2);
  return (w.length ? w : [String(name || "")]).join(" ").slice(0, 60).trim();
}
function wordMatch(r, t) {
  if (r === t) return true;
  let p = 0; while (p < r.length && p < t.length && r[p] === t[p]) p++;
  if (p === t.length) return r.length - t.length <= 2;
  if (p === r.length) return r.length >= 4 && t.length - r.length <= 2;
  if (t.length >= 5 && r.endsWith(t)) return true;          // „Naturjoghurt“ passt zu „Joghurt“
  return false;
}
// Passt ein Angebot zum Suchbegriff? Jedes Wort des Begriffs muss im Angebot vorkommen.
export function offerMatches(query, offerText) {
  const q = words(query), t = words(offerText);
  if (!q.length) return false;
  return q.every(w => t.some(x => wordMatch(x, w)));
}
export function isBio(text) { return /\bbio\b|\bbioland\b|\bdemeter\b|\bnaturland\b|\bökologisch|\boeko/i.test(String(text || "")); }

/* ---------- Angebot aus marktguru-Daten ---------- */
const cents = v => (v == null || v === "" || isNaN(Number(v))) ? null : Math.round(Number(v) * 100);
export function shopOfAdvertiser(name, shops) {
  const a = fold(name).replace(/[^a-z]/g, "");
  return shops.find(s => { const k = fold(s).replace(/[^a-z]/g, ""); return k && (a === k || a.startsWith(k)); }) || "";
}
export function normalizeOffer(o, shops) {
  const adv = (o.advertisers || []).map(a => a && (a.name || a.uniqueName)).filter(Boolean);
  let shop = ""; for (const a of adv) { shop = shopOfAdvertiser(a, shops); if (shop) break; }
  const title = [o.product && o.product.name, o.description].filter(Boolean)[0] || "";
  const brand = (o.brand && o.brand.name) || "";
  const unit = o.unit && (o.unit.shortName || o.unit.name) || "";
  const vol = o.volume != null && o.volume !== "" ? String(o.volume).replace(".", ",") : "";
  const qty = o.quantity && Number(o.quantity) > 1 ? Number(o.quantity) + " × " : "";
  const amount = vol ? qty + vol + (unit ? " " + unit : "") : "";
  const refUnit = /^(kg|g)$/i.test(unit) ? "kg" : /^(l|ml)$/i.test(unit) ? "l" : unit ? unit : "";
  const dates = (o.validityDates || []).filter(d => d && d.to);
  const from = dates.length ? dates.map(d => String(d.from || "").slice(0, 10)).sort()[0] : "";
  const to = dates.length ? dates.map(d => String(d.to).slice(0, 10)).sort().pop() : "";
  const text = [brand, o.product && o.product.name, o.description].filter(Boolean).join(" ");
  return { id: String(o.id || ""), shop, adv: adv.join("/"), title: String(title).slice(0, 140), brand: String(brand).slice(0, 60), price: cents(o.price), oldPrice: cents(o.oldPrice),
    refPrice: cents(o.referencePrice), refUnit, amount: amount.slice(0, 40), bio: isBio(text) ? 1 : 0, from, to, text };
}

/* ---------- Einstellungen ---------- */
export function readConfig(settings) {
  let c = {}; try { c = JSON.parse(settings.offers_config || "{}") || {}; } catch (e) {}
  return { zip: /^\d{5}$/.test(c.zip || "") ? c.zip : DEFAULT_CONFIG.zip, shops: Array.isArray(c.shops) ? c.shops.map(String).slice(0, 20) : [],
    zipByShop: c.zipByShop && typeof c.zipByShop === "object" ? c.zipByShop : {}, rules: Object.assign({}, DEFAULT_CONFIG.rules, c.rules || {}) };
}
const today = () => new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);   // ungefähr deutsche Zeit

/* ---------- Ein Artikel prüfen ---------- */
export async function checkItem(env, item, config, query) {
  const shops = config.shops;
  if (!shops.length) return { offers: [], query };
  // Postleitzahlen: Standard und Ausnahmen je Geschäft (z. B. Edeka woanders)
  const zips = new Map();
  for (const s of shops) { const z = /^\d{5}$/.test(config.zipByShop[s] || "") ? config.zipByShop[s] : config.zip; if (!zips.has(z)) zips.set(z, []); zips.get(z).push(s); }
  const found = new Map();
  for (const [zip, zshops] of zips) {
    const list = await searchOffers(env, query, zip);
    for (const raw of list) {
      const o = normalizeOffer(raw, shops);
      if (!o.id || !o.shop || !zshops.includes(o.shop) || o.price == null) continue;
      if (!offerMatches(query, o.text)) continue;
      if (!found.has(o.id)) found.set(o.id, o);
    }
  }
  const offers = [...found.values()];
  const now = new Date().toISOString(), t = today();
  const stmts = [env.DB.prepare("DELETE FROM offers WHERE item_id = ? AND valid_to >= ?").bind(item.id, t)];
  for (const o of offers) {
    stmts.push(env.DB.prepare(`INSERT INTO offers (item_id, offer_id, shop, title, brand, price, old_price, ref_price, ref_unit, amount, bio, valid_from, valid_to, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(item_id, offer_id) DO UPDATE SET price = excluded.price, valid_to = excluded.valid_to, fetched_at = excluded.fetched_at`)
      .bind(item.id, o.id, o.shop, o.title, o.brand, o.price, o.oldPrice, o.refPrice, o.refUnit, o.amount, o.bio, o.from, o.to, now));
  }
  stmts.push(env.DB.prepare(`INSERT INTO offer_watch (item_id, query, checked_at) VALUES (?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET checked_at = excluded.checked_at, query = CASE WHEN offer_watch.query = '' THEN excluded.query ELSE offer_watch.query END`).bind(item.id, "", now));
  await env.DB.batch(stmts);
  return { offers, query };
}

/* ---------- Cron: fällige Artikel prüfen, Preisalarme verschicken ---------- */
export async function refreshOffers(env, deliverAlarm, nowMs = Date.now()) {
  const settings = {}; for (const r of (await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('offers_config','stores')").all()).results) settings[r.key] = r.value;
  const config = readConfig(settings);
  if (!config.shops.length) return [];
  // Läden, in denen eines der Geschäfte in der Nähe liegt (z. B. Supermarkt, Drogerie)
  let stores = []; try { stores = JSON.parse(settings.stores || "[]"); } catch (e) {}
  const near = stores.filter(s => (s.labels || []).some(l => config.shops.includes(l))).map(s => s.id);
  const since = new Date(nowMs - RECHECK_MS).toISOString();
  const { results } = await env.DB.prepare(`SELECT i.id, i.name, i.store, w.query, w.checked_at, w.alarm, w.alarm_max, w.alarm_sent
    FROM items i LEFT JOIN offer_watch w ON w.item_id = i.id
    WHERE ((i.done = 0 AND i.store IN (${near.map(() => "?").join(",") || "''"})) OR w.alarm = 1)
      AND (w.checked_at IS NULL OR w.checked_at < ?)
    ORDER BY w.checked_at IS NOT NULL, w.checked_at LIMIT ?`).bind(...near, since, PER_RUN).all();
  const out = [];
  for (const it of results) {
    const query = it.query || queryFor(it.name);
    try {
      const r = await checkItem(env, it, config, query);
      out.push({ id: it.id, n: r.offers.length });
      if (it.alarm) await checkAlarm(env, it, deliverAlarm);
    } catch (e) {
      out.push({ id: it.id, error: String(e && e.message || e) });
      // Fehler (z. B. marktguru nicht erreichbar): später nochmal, aber nicht sofort
      await env.DB.prepare(`INSERT INTO offer_watch (item_id, query, checked_at) VALUES (?, '', ?) ON CONFLICT(item_id) DO UPDATE SET checked_at = excluded.checked_at`)
        .bind(it.id, new Date(nowMs - RECHECK_MS + 3600 * 1000).toISOString()).run();
      if (/HTTP 4\d\d|Schlüssel/.test(String(e && e.message))) break;
    }
  }
  // sehr alte Angebote aufräumen (Preisverlauf: ein Jahr)
  await env.DB.prepare("DELETE FROM offers WHERE valid_to < ?").bind(new Date(nowMs - 400 * 86400000).toISOString().slice(0, 10)).run();
  return out;
}

// Preisalarm: gültiges Angebot (heute oder demnächst) unter dem Wunschpreis, noch nicht gemeldet
export async function checkAlarm(env, it, deliverAlarm) {
  const t = today();
  const { results } = await env.DB.prepare("SELECT offer_id, shop, title, brand, price, old_price, amount, valid_from, valid_to FROM offers WHERE item_id = ? AND valid_to >= ? ORDER BY price").bind(it.id, t).all();
  const sent = new Set(String(it.alarm_sent || "").split(",").filter(Boolean));
  const hits = results.filter(o => !sent.has(o.offer_id) && (it.alarm_max == null || o.price <= it.alarm_max));
  if (!hits.length) return null;
  const msg = alarmMessage(it.name, hits);
  if (deliverAlarm) await deliverAlarm(msg);
  const keep = [...sent, ...hits.map(h => h.offer_id)].slice(-60).join(",");
  await env.DB.prepare("UPDATE offer_watch SET alarm_sent = ? WHERE item_id = ?").bind(keep, it.id).run();
  return msg;
}
const eur = c => (c / 100).toFixed(2).replace(".", ",") + " €";
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
function dayText(iso) { const d = new Date(iso + "T12:00:00Z"); return WD[d.getUTCDay()] + " " + d.getUTCDate() + "." + (d.getUTCMonth() + 1) + "."; }
export function alarmMessage(name, hits) {
  const best = hits[0];
  const one = o => o.shop + ": " + (o.brand && !String(o.title).toLowerCase().includes(String(o.brand).toLowerCase()) ? o.brand + " " : "") + o.title + (o.amount ? " (" + o.amount + ")" : "") +
    " für " + eur(o.price) + (o.old_price && o.old_price > o.price ? " statt " + eur(o.old_price) : "") +
    (o.valid_from > today() ? ", ab " + dayText(o.valid_from) : ", bis " + dayText(o.valid_to));
  const body = hits.slice(0, 3).map(one).join("\n") + (hits.length > 3 ? "\nund " + (hits.length - 3) + " weitere" : "");
  return { title: "Preisalarm: " + name + " ab " + eur(best.price), body, tag: "preisalarm-" + name, url: "/?angebote" };
}

// Testlauf: settings.offers_probe = {"zip":"50354","queries":["Tomatenmark",…]} → Ergebnisse in offers_probe-Tabelle
export async function runOffersProbe(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'offers_probe'").first();
  if (!row) return;
  await env.DB.prepare("DELETE FROM settings WHERE key = 'offers_probe'").run();
  let job; try { job = JSON.parse(row.value); } catch (e) { return; }
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS offers_probe (q TEXT, at TEXT, ok INTEGER, n INTEGER, sample TEXT, raw_first TEXT)").run();
  for (const q of (job.queries || []).slice(0, 25)) {
    const at = new Date().toISOString();
    try {
      const list = await searchOffers(env, q, job.zip || "50354");
      const sample = list.slice(0, 15).map(o => ({
        id: o.id, price: o.price, old: o.oldPrice, ref: o.referencePrice, unit: o.unit && (o.unit.shortName || o.unit.name), vol: o.volume, qty: o.quantity,
        desc: (o.description || "").slice(0, 80), product: o.product && o.product.name, brand: o.brand && o.brand.name,
        shop: (o.advertisers || []).map(a => a.name || a.uniqueName).join("/"),
        valid: (o.validityDates || []).map(v => (v.from || "").slice(0, 10) + ".." + (v.to || "").slice(0, 10)).join(",")
      }));
      await env.DB.prepare("INSERT INTO offers_probe VALUES (?, ?, 1, ?, ?, ?)").bind(q, at, list.length, JSON.stringify(sample), JSON.stringify(list[0] || null).slice(0, 4000)).run();
    } catch (e) {
      await env.DB.prepare("INSERT INTO offers_probe VALUES (?, ?, 0, 0, ?, NULL)").bind(q, at, String(e && e.message || e).slice(0, 500)).run();
    }
  }
}
