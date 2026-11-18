// Kassenzettel: lesen (Text oder Foto), speichern, anzeigen, löschen; Preise je Artikel.
import { parseReceipt, rawKey, KNOWN_SHOPS } from "./receipt.js";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_LINES = 150;
// Fotos: Workers AI (im kostenlosen Kontingent enthalten). Erst Mistral, sonst Llama als Ersatz.
const OCR_MODELS = ["@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.2-11b-vision-instruct"];
const OCR_PROMPT = "Das Bild zeigt einen Abschnitt eines deutschen Kassenbons. Schreibe den Text exakt ab, Zeile für Zeile, genau so wie er auf dem Bon steht. " +
  "Jede Bon-Zeile in eine eigene Zeile. Preise mit Komma (z. B. 1,29) und Steuerkennzeichen (A, B …) am Zeilenende, Minuszeichen bei Rabatten beibehalten. " +
  "Mengenzeilen wie „0,672 kg x 2,29 EUR/kg“ oder „2 Stk x 1,45“ als eigene Zeile. Nichts erklären, nichts zusammenfassen, keine Tabellen, kein Markdown.";

export async function receiptApi(request, env, settings, url, h) {
  const path = url.pathname, method = request.method;

  // Text eines PDF-Bons (im Browser ausgelesen) → erkannte Zeilen
  if (path === "/api/receipt/parse" && method === "POST") {
    const b = await h.readJson(request);
    if (!b || typeof b.text !== "string" || b.text.length > 60000) return h.json({ error: "Kein lesbarer Text." }, 400);
    return h.json(await withAliases(env, parseReceipt(b.text)));
  }

  // Foto eines Bons → Text abschreiben lassen → erkannte Zeilen
  if (path === "/api/receipt/ocr" && method === "POST") {
    if (!env.AI) return h.json({ error: "Die Bilderkennung ist noch nicht eingerichtet (Workers AI fehlt)." }, 500);
    const b = await h.readJson(request);
    const imgs = b && Array.isArray(b.images) ? b.images : [];
    if (!imgs.length || imgs.length > 8 || imgs.some(x => typeof x !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x) || x.length > 2500000))
      return h.json({ error: "Bild konnte nicht übertragen werden." }, 400);
    let text = "";
    try { text = (await Promise.all(imgs.map(img => ocr(env, img)))).join("\n"); }
    catch (e) { return h.json({ error: "Das Foto konnte nicht gelesen werden: " + (e && e.message || e) }, 502); }
    const r = await withAliases(env, parseReceipt(text));
    r.text = text.slice(0, 20000);
    return h.json(r);
  }

  if (path === "/api/receipt/save" && method === "POST") {
    const b = await h.readJson(request);
    const r = checkReceipt(b, h.people(settings));
    if (typeof r === "string") return h.json({ error: r }, 400);
    const dup = await env.DB.prepare("SELECT id FROM receipts WHERE shop = ? AND at = ? AND total = ?").bind(r.shop, r.at, r.total).first();
    if (dup) return h.json({ error: "Dieser Kassenzettel ist schon gespeichert." }, 409);
    const now = new Date().toISOString(), id = "r" + Date.now().toString(36) + rnd();
    const stmts = [env.DB.prepare("INSERT INTO receipts (id, shop, store, at, total, source, person, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, r.shop, r.store, r.at, r.total, r.source, r.person, now)];
    // vorhandene Artikel, die zugeordnet wurden
    const ids = [...new Set(r.lines.map(l => l.itemId).filter(Boolean))];
    const existing = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      const { results } = await env.DB.prepare("SELECT id, name, store, cat, shop, done FROM items WHERE id IN (" + part.map(() => "?").join(",") + ")").bind(...part).all();
      for (const x of results) existing.set(x.id, x);
    }
    const created = new Map();   // neuer Name → neue id (gleicher Name zweimal auf dem Bon = ein Artikel)
    const ticked = new Set();
    r.lines.forEach((l, pos) => {
      let itemId = l.itemId && existing.has(l.itemId) ? l.itemId : null;
      if (!itemId && l.newName) {
        const k = l.newName.toLowerCase();
        if (!created.has(k)) {
          const nid = "i" + Date.now().toString(36) + rnd();
          created.set(k, nid);
          // neuer Artikel landet unter „Schon mal gekauft“ des Ladens
          stmts.push(env.DB.prepare("INSERT INTO items (id, name, store, note, done, added_at, done_at, updated_at, cat, buy_count, added_by, shop) VALUES (?, ?, ?, '', 1, NULL, ?, ?, '', 1, ?, ?)")
            .bind(nid, l.newName, r.store, now, now, r.person, r.shop));
        }
        itemId = created.get(k);
      }
      const kind = l.ignore ? "skip" : l.kind;
      stmts.push(env.DB.prepare("INSERT INTO receipt_lines (receipt_id, pos, raw, ean, qty, unit, unit_price, price, discount, kind, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, pos, l.raw, l.ean, l.qty, l.unit, l.unitPrice, l.price, l.discount, kind, itemId));
      // Zuordnung merken, damit es beim nächsten Bon von selbst passt
      if (itemId || l.ignore) stmts.push(env.DB.prepare("INSERT INTO receipt_alias (shop, raw_key, item_id) VALUES (?, ?, ?) ON CONFLICT(shop, raw_key) DO UPDATE SET item_id = excluded.item_id")
        .bind(r.shop, rawKey(l.raw), itemId || "-"));
      // Was auf der Liste stand und jetzt gekauft wurde: abhaken (zählt wie ein normaler Kauf)
      const ex = itemId && existing.get(itemId);
      if (r.tick && ex && ex.done === 0 && !ticked.has(itemId)) {
        ticked.add(itemId);
        stmts.push(env.DB.prepare("UPDATE items SET done = 1, done_at = ?, updated_at = ?, buy_count = buy_count + 1, prio = '' WHERE id = ? AND done = 0").bind(now, now, itemId));
        stmts.push(env.DB.prepare("INSERT INTO purchases (item_id, name, store, cat, shop, person, at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(itemId, ex.name, ex.store, ex.cat || "", ex.shop || "", r.person, now));
      }
    });
    stmts.push(h.bumpRev(env));
    const res = await env.DB.batch(stmts);
    return h.json({ ok: true, id, ticked: ticked.size, created: created.size, rev: h.revOf(res[res.length - 1]) });
  }

  if (path === "/api/receipts" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT r.id, r.shop, r.store, r.at, r.total, r.source, r.person,
        (SELECT COUNT(*) FROM receipt_lines l WHERE l.receipt_id = r.id AND l.kind = 'item') AS n
      FROM receipts r ORDER BY r.at DESC LIMIT 300`).all();
    return h.json({ receipts: results });
  }

  // Alle Bon-Zeilen (für die Statistik „laut Kassenzettel gekauft“)
  if (path === "/api/receipt-lines" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT r.at, r.shop, r.store, l.raw, l.item_id, l.qty, l.unit, l.price
      FROM receipt_lines l JOIN receipts r ON r.id = l.receipt_id WHERE l.kind = 'item' ORDER BY r.at DESC LIMIT 20000`).all();
    return h.json({ lines: results.map(x => ({ at: x.at, shop: x.shop, store: x.store, raw: x.raw, itemId: x.item_id || "", qty: x.qty, unit: x.unit, price: x.price })) });
  }

  if (path === "/api/receipt" && method === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return h.json({ error: "Ungültige Anfrage." }, 400);
    const r = await env.DB.prepare("SELECT id, shop, store, at, total, source, person FROM receipts WHERE id = ?").bind(id).first();
    if (!r) return h.json({ error: "Nicht gefunden." }, 404);
    const { results } = await env.DB.prepare("SELECT raw, ean, qty, unit, unit_price, price, discount, kind, item_id FROM receipt_lines WHERE receipt_id = ? ORDER BY pos").bind(id).all();
    r.lines = results.map(l => ({ raw: l.raw, ean: l.ean, qty: l.qty, unit: l.unit, unitPrice: l.unit_price, price: l.price, discount: l.discount, kind: l.kind, itemId: l.item_id || "" }));
    return h.json(r);
  }

  if (path === "/api/receipt/delete" && method === "POST") {
    const b = await h.readJson(request);
    if (!b || typeof b.id !== "string" || !ID_RE.test(b.id)) return h.json({ error: "Ungültige Anfrage." }, 400);
    await env.DB.batch([env.DB.prepare("DELETE FROM receipt_lines WHERE receipt_id = ?").bind(b.id), env.DB.prepare("DELETE FROM receipts WHERE id = ?").bind(b.id)]);
    return h.json({ ok: true });
  }

  // Preise eines Artikels: die letzten Käufe je Geschäft
  if (path === "/api/prices" && method === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return h.json({ error: "Ungültige Anfrage." }, 400);
    const { results } = await env.DB.prepare(`SELECT r.shop, r.at, l.raw, l.qty, l.unit, l.unit_price, l.price, l.discount
      FROM receipt_lines l JOIN receipts r ON r.id = l.receipt_id WHERE l.item_id = ? ORDER BY r.at DESC LIMIT 100`).bind(id).all();
    // dazu die Prospekt-Angebote (auch vergangene) für den Preisverlauf
    const { results: offers } = await env.DB.prepare(`SELECT shop, title, brand, price, old_price, ref_price, ref_unit, amount, bio, valid_from, valid_to
      FROM offers WHERE item_id = ? ORDER BY valid_from DESC LIMIT 60`).bind(id).all();
    return h.json({ prices: results.map(x => ({ shop: x.shop, at: x.at, raw: x.raw, qty: x.qty, unit: x.unit, unitPrice: x.unit_price, price: x.price, discount: x.discount })),
      offers: offers.map(o => ({ shop: o.shop, title: o.title, brand: o.brand, price: o.price, oldPrice: o.old_price, refPrice: o.ref_price, refUnit: o.ref_unit, amount: o.amount, bio: !!o.bio, from: o.valid_from, to: o.valid_to })) });
  }

  return null;
}

// gelernte Zuordnungen mitschicken: erst für dieses Geschäft, dann allgemein
async function withAliases(env, parsed) {
  const { results } = await env.DB.prepare("SELECT shop, raw_key, item_id FROM receipt_alias").all();
  const own = {}, any = {};
  for (const a of results) { if (a.shop === parsed.shop) own[a.raw_key] = a.item_id; else if (!(a.raw_key in any)) any[a.raw_key] = a.item_id; }
  parsed.lines.forEach(l => { const k = rawKey(l.raw); l.alias = k in own ? own[k] : (k in any && any[k] !== "-" ? any[k] : ""); });
  parsed.knownShops = KNOWN_SHOPS;
  return parsed;
}

function checkReceipt(b, people) {
  if (!b || typeof b !== "object") return "Ungültige Anfrage.";
  const shop = String(b.shop || "").replace(/[\u0000-\u001f<>|,]/g, "").trim().slice(0, 30);
  if (!shop) return "Bitte das Geschäft auswählen.";
  if (typeof b.at !== "string" || !AT_RE.test(b.at)) return "Bitte das Datum angeben.";
  const store = typeof b.store === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(b.store) ? b.store : "";
  if (!store) return "Bitte den Laden auswählen.";
  const total = Math.round(Number(b.total));
  if (!Number.isFinite(total) || total < 0 || total > 10000000) return "Die Summe stimmt nicht.";
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > MAX_LINES) return "Keine Zeilen gefunden.";
  const lines = [];
  for (const l of b.lines) {
    if (!l || typeof l !== "object") return "Ungültige Zeile.";
    const raw = String(l.raw || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80);
    if (!raw) return "Ungültige Zeile.";
    const int = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(-max, Math.min(max, n)) : 0; };
    const newName = String(l.newName || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
    lines.push({ raw, ean: /^\d{8,14}$/.test(l.ean || "") ? l.ean : "", qty: Math.max(0, Math.min(10000, Number(l.qty) || 1)), unit: l.unit === "kg" ? "kg" : "stk",
      unitPrice: int(l.unitPrice, 1000000), price: int(l.price, 1000000), discount: int(l.discount, 1000000),
      kind: ["item", "pfand", "bag"].includes(l.kind) ? l.kind : "item",
      itemId: typeof l.itemId === "string" && ID_RE.test(l.itemId) ? l.itemId : "", newName, ignore: l.ignore === true });
  }
  return { shop, store, at: b.at, total, source: b.source === "foto" ? "foto" : "pdf", person: people.includes(b.person) ? b.person : "", tick: b.tick !== false, lines };
}

async function ocr(env, dataUrl) {
  let lastErr;
  for (const model of OCR_MODELS) {
    try {
      const out = model.includes("llama") ? await runLlama(env, model, dataUrl) : await env.AI.run(model, {
        messages: [{ role: "user", content: [{ type: "text", text: OCR_PROMPT }, { type: "image_url", image_url: { url: dataUrl } }] }],
        max_tokens: 2500, temperature: 0
      });
      const t = textOf(out);
      if (t.trim()) return t.replace(/```[a-z]*\n?/gi, "");
      lastErr = new Error("leere Antwort");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("unbekannter Fehler");
}
async function runLlama(env, model, dataUrl) {
  const input = { messages: [{ role: "user", content: OCR_PROMPT }], image: dataUrl, max_tokens: 2500, temperature: 0 };
  try { return await env.AI.run(model, input); }
  catch (e) {
    // Llama verlangt einmalig die Zustimmung zur Meta-Lizenz
    if (/agree/i.test(String(e && e.message))) { await env.AI.run(model, { prompt: "agree" }); return await env.AI.run(model, input); }
    throw e;
  }
}
function textOf(out) {
  if (!out) return "";
  if (typeof out === "string") return out;
  if (typeof out.response === "string") return out.response;
  if (out.choices && out.choices[0]) { const m = out.choices[0].message || {}; return typeof m.content === "string" ? m.content : ""; }
  if (out.result) return textOf(out.result);
  return "";
}
function rnd() { const b = new Uint8Array(4); crypto.getRandomValues(b); return Array.from(b, x => x.toString(36)).join("").slice(0, 6); }
