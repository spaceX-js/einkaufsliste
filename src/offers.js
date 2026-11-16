// Angebote aus Prospekten (inoffiziell über marktguru.de – nur private Nutzung).
// Die Schlüssel stehen öffentlich im HTML der marktguru-Startseite; sie werden in settings zwischengespeichert.

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

export async function marktguruKeys(env, force = false) {
  if (!force) {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'mg_keys'").first();
    if (row) { try { const k = JSON.parse(row.value); if (k.apiKey && k.clientKey) return k; } catch (e) {} }
  }
  const res = await fetch("https://www.marktguru.de/", { headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "de-DE" } });
  const html = await res.text();
  const re = /<script\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let m, keys = null;
  while ((m = re.exec(html)) !== null) {
    try { const cfg = JSON.parse(m[1]); const c = cfg.config || cfg; if (c && c.apiKey && c.clientKey) keys = { apiKey: c.apiKey, clientKey: c.clientKey }; } catch (e) {}
  }
  if (!keys) throw new Error("marktguru: keine Schlüssel gefunden (HTTP " + res.status + ", " + html.length + " Zeichen)");
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('mg_keys', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(keys)).run();
  return keys;
}

export async function searchOffers(env, q, zipCode, limit = 60) {
  let keys = await marktguruKeys(env);
  const url = "https://api.marktguru.de/api/v1/offers/search?" + new URLSearchParams({ as: "web", q, zipCode: String(zipCode), limit: String(limit), offset: "0" });
  const get = k => fetch(url, { headers: { "x-apikey": k.apiKey, "x-clientkey": k.clientKey, "User-Agent": UA, "Accept": "application/json", "Origin": "https://www.marktguru.de", "Referer": "https://www.marktguru.de/" } });
  let res = await get(keys);
  if (res.status === 401 || res.status === 403) { keys = await marktguruKeys(env, true); res = await get(keys); }
  const text = await res.text();
  if (!res.ok) throw new Error("marktguru: HTTP " + res.status + " " + text.slice(0, 200));
  const data = JSON.parse(text);
  return Array.isArray(data.results) ? data.results : [];
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
