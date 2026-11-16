// API für Angebote, Preisalarm und Ladenvergleich.
import { readConfig, checkItem, queryFor, checkAlarm, refreshOffers, watchedCount } from "./offers.js";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const today = () => new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);

export async function offersApi(request, env, settings, url, h) {
  const path = url.pathname, method = request.method;

  if (path === "/api/offers" && method === "GET") {
    const config = readConfig(settings);
    const { results: offers } = await env.DB.prepare(`SELECT item_id, offer_id, shop, title, brand, price, old_price, ref_price, ref_unit, amount, bio, valid_from, valid_to
      FROM offers WHERE valid_to >= ? ORDER BY price`).bind(today()).all();
    const { results: watch } = await env.DB.prepare("SELECT item_id, query, checked_at, alarm, alarm_max FROM offer_watch").all();
    // Bon-Texte je Artikel: daran erkennt die App Angebote für genau die Sorte, die ihr schon gekauft habt
    const { results: raws } = await env.DB.prepare("SELECT DISTINCT item_id, raw FROM receipt_lines WHERE item_id IS NOT NULL AND item_id <> '' AND kind = 'item' LIMIT 5000").all();
    const bought = {}; for (const r of raws) (bought[r.item_id] = bought[r.item_id] || []).push(r.raw);
    return h.json({ config: { zip: config.zip, shops: config.shops, zipByShop: config.zipByShop }, today: today(),
      offers: offers.map(o => ({ itemId: o.item_id, id: o.offer_id, shop: o.shop, title: o.title, brand: o.brand, price: o.price, oldPrice: o.old_price, refPrice: o.ref_price,
        refUnit: o.ref_unit, amount: o.amount, bio: !!o.bio, from: o.valid_from, to: o.valid_to })),
      bought,
      watch: Object.fromEntries(watch.map(w => [w.item_id, { query: w.query, checkedAt: w.checked_at, alarm: !!w.alarm, alarmMax: w.alarm_max }])) });
  }

  // Geschäfte in der Nähe und Postleitzahl
  if (path === "/api/offers/config" && method === "POST") {
    const b = await h.readJson(request);
    if (!b || typeof b !== "object") return h.json({ error: "Ungültige Anfrage." }, 400);
    const old = readConfig(settings);
    const zip = b.zip == null ? old.zip : String(b.zip).trim();
    if (!/^\d{5}$/.test(zip)) return h.json({ error: "Bitte eine Postleitzahl mit 5 Ziffern eingeben." }, 400);
    const clean = v => String(v || "").replace(/[\u0000-\u001f<>|,]/g, "").trim().slice(0, 30);
    const shops = Array.isArray(b.shops) ? [...new Set(b.shops.map(clean).filter(Boolean))].slice(0, 20) : old.shops;
    const zipByShop = {};
    const src = b.zipByShop && typeof b.zipByShop === "object" ? b.zipByShop : old.zipByShop;
    for (const [k, v] of Object.entries(src)) if (shops.includes(k) && /^\d{5}$/.test(String(v)) && String(v) !== zip) zipByShop[k] = String(v);
    const cfg = { zip, shops, zipByShop, rules: old.rules };
    // geänderte Geschäfte/PLZ: alles neu prüfen
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('offers_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(cfg)),
      env.DB.prepare("UPDATE offer_watch SET checked_at = NULL"),
      env.DB.prepare("DELETE FROM offers WHERE valid_to >= ?").bind(today())]);
    return h.json({ ok: true, config: { zip, shops, zipByShop } });
  }

  // Suchbegriff und Preisalarm je Artikel
  if (path === "/api/offers/watch" && method === "POST") {
    const b = await h.readJson(request);
    if (!b || typeof b.itemId !== "string" || !ID_RE.test(b.itemId)) return h.json({ error: "Ungültige Anfrage." }, 400);
    const item = await env.DB.prepare("SELECT id, name FROM items WHERE id = ?").bind(b.itemId).first();
    if (!item) return h.json({ error: "Artikel nicht gefunden." }, 404);
    const old = await env.DB.prepare("SELECT query, alarm, alarm_max FROM offer_watch WHERE item_id = ?").bind(item.id).first();
    let query = typeof b.query === "string" ? b.query.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) : (old ? old.query : "");
    if (query === queryFor(item.name)) query = "";
    const alarm = b.alarm == null ? !!(old && old.alarm) : b.alarm === true;
    let max = b.alarmMax === undefined ? (old ? old.alarm_max : null) : b.alarmMax;
    if (max !== null) { max = Math.round(Number(max)); if (!Number.isFinite(max) || max <= 0 || max > 100000) return h.json({ error: "Der Wunschpreis stimmt nicht." }, 400); }
    const changed = !old || old.query !== query;
    const person = h.people(settings).includes(b.person) ? b.person : "";
    await env.DB.prepare(`INSERT INTO offer_watch (item_id, query, checked_at, alarm, alarm_max, alarm_person) VALUES (?, ?, NULL, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET query = excluded.query, alarm = excluded.alarm, alarm_max = excluded.alarm_max, alarm_person = excluded.alarm_person,
        checked_at = CASE WHEN ? THEN NULL ELSE offer_watch.checked_at END,
        alarm_sent = CASE WHEN offer_watch.alarm_max IS NOT excluded.alarm_max OR offer_watch.alarm <> excluded.alarm THEN '' ELSE offer_watch.alarm_sent END`)
      .bind(item.id, query, alarm ? 1 : 0, max, person, changed ? 1 : 0).run();
    return h.json({ ok: true, query: query || queryFor(item.name), auto: !query });
  }

  // „Neue Angebote suchen“: Start merken, dann portionsweise alles prüfen, was seit dem Start noch nicht dran war.
  // Der Browser ruft das so lange auf, bis nichts mehr offen ist (je Aufruf höchstens 8 Artikel).
  if (path === "/api/offers/refresh" && method === "POST") {
    const b = await h.readJson(request) || {};
    const config = readConfig(settings);
    if (!config.shops.length) return h.json({ error: "Bitte zuerst die Geschäfte in der Nähe auswählen." }, 400);
    let stores = []; try { stores = JSON.parse(settings.stores || "[]"); } catch (e) {}
    let started = settings.offers_refresh;
    if (b.start) {
      // höchstens alle 2 Minuten von vorn
      if (started && Date.now() - Date.parse(started) < 2 * 60 * 1000 && !b.again) {} else {
        started = new Date().toISOString();
        await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('offers_refresh', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(started).run();
      }
    }
    if (!started) return h.json({ error: "Ungültige Anfrage." }, 400);
    let errors = [];
    const res = await refreshOffers(env, h.deliverAll, Date.now(), { since: started, limit: 8 });
    errors = res.filter(r => r.error).map(r => r.error);
    const c = await watchedCount(env, config, stores, started);
    // Fehler bei allen Artikeln dieser Portion: abbrechen statt endlos weiter
    if (res.length && errors.length === res.length) return h.json({ error: "Angebote konnten nicht abgerufen werden: " + errors[0] }, 502);
    return h.json({ ok: true, done: c.total - c.due, total: c.total, remaining: res.length ? c.due : 0 });
  }

  // Einen Artikel sofort prüfen (z. B. nach geändertem Suchbegriff)
  if (path === "/api/offers/check" && method === "POST") {
    const b = await h.readJson(request);
    if (!b || typeof b.itemId !== "string" || !ID_RE.test(b.itemId)) return h.json({ error: "Ungültige Anfrage." }, 400);
    const it = await env.DB.prepare(`SELECT i.id, i.name, w.query, w.checked_at, w.alarm, w.alarm_max, w.alarm_sent FROM items i LEFT JOIN offer_watch w ON w.item_id = i.id WHERE i.id = ?`).bind(b.itemId).first();
    if (!it) return h.json({ error: "Artikel nicht gefunden." }, 404);
    if (it.checked_at && Date.now() - Date.parse(it.checked_at) < 60 * 1000) return h.json({ ok: true, skipped: true });
    const config = readConfig(settings);
    if (!config.shops.length) return h.json({ error: "Bitte zuerst die Geschäfte in der Nähe auswählen." }, 400);
    try {
      const r = await checkItem(env, it, config, it.query || queryFor(it.name));
      if (it.alarm) await checkAlarm(env, it, h.deliverAll);
      return h.json({ ok: true, n: r.offers.length, query: r.query });
    } catch (e) { return h.json({ error: "Angebote konnten nicht abgerufen werden: " + (e && e.message || e) }, 502); }
  }

  // Letzter Kassenzettel-Preis je Artikel und Geschäft (für den Ladenvergleich)
  if (path === "/api/prices/latest" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT item_id, shop, at, qty, unit, unit_price, price FROM (
        SELECT l.item_id, r.shop, r.at, l.qty, l.unit, l.unit_price, l.price,
          ROW_NUMBER() OVER (PARTITION BY l.item_id, r.shop ORDER BY r.at DESC) AS rn
        FROM receipt_lines l JOIN receipts r ON r.id = l.receipt_id WHERE l.item_id IS NOT NULL AND l.item_id <> '' AND l.kind = 'item')
      WHERE rn = 1`).all();
    return h.json({ prices: results.map(x => ({ itemId: x.item_id, shop: x.shop, at: x.at, qty: x.qty, unit: x.unit, unitPrice: x.unit_price, price: x.price })) });
  }

  return null;
}
