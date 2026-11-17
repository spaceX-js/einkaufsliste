// Klicktest Kassenzettel im echten Browser (nur lokal, nicht Teil von npm test):
//   PLAYWRIGHT=… PDFLIB=… node --experimental-sqlite --no-warnings test/e2e-kassenzettel.mjs
// Erzeugt einen Beispiel-Bon als PDF, lädt ihn hoch, prüft Vorschläge, Zuordnung, Speichern, Preise.
// Das Foto wird mit einer nachgebauten Bilderkennung getestet (liefert festen Text).
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import worker, { pbkdf2 } from "../src/index.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const { PDFDocument, StandardFonts } = require(process.env.PDFLIB || "pdf-lib");

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("../d1-schema.sql", import.meta.url), "utf8"));
const run = (sql, args) => { const p = db.prepare(sql); if (/returning/i.test(sql)) return { results: p.all(...args) }; p.run(...args); return { results: [] }; };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a), all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) ?? null, run: async () => run(sql, args) });
const DB = { prepare: s => stmt(s), batch: async l => l.map(s => run(s.sql, s.args)) };
const types = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", png: "image/png", webmanifest: "application/manifest+json" };
const ASSETS = { fetch: async req => { let p = new URL(req.url).pathname; if (p === "/") p = "/index.html"; const f = new URL("../public" + p, import.meta.url);
  return existsSync(f) ? new Response(readFileSync(f), { headers: { "Content-Type": types[p.split(".").pop()] || "application/octet-stream" } }) : new Response("nicht da", { status: 404 }); } };
const OCR_TEXT = "Lidl\nKiwi Gold 0,49 x 2 0,98 A\nBio Feldsalat 1,29 A\nLidl Plus Rabatt -0,18\nzu zahlen 2,09\n14.11.26 18:31";
let aiCalls = 0, mgCalls = 0;
const OFFERS_FETCH = async url => { mgCalls++; if (String(url) === "https://www.marktguru.de/") return new Response('<script type="application/json">{"config":{"apiKey":"A","clientKey":"C"}}</script>');
  return new Response(JSON.stringify({ results: [] })); };
const AI = { run: async () => { aiCalls++; await new Promise(r => setTimeout(r, 300)); return { response: OCR_TEXT }; } };

const salt = "00112233445566778899aabbccddeeff";
db.prepare("INSERT INTO settings (key,value) VALUES ('pw_salt',?),('pw_hash',?),('session_secret',?),('rev','1'),('stores',?)").run(salt, await pbkdf2("geheim123", salt), "cd".repeat(32),
  JSON.stringify([{ id: "supermarkt", name: "Supermarkt", labels: ["Lidl", "Penny", "Rewe"] }, { id: "drogerie", name: "Drogerie", labels: ["dm"] }]));
const ins = db.prepare("INSERT INTO items (id,name,store,note,done,added_at,done_at,updated_at,buy_count,added_by) VALUES (?,?,?,?,?,?,?,?,?,?)");
[["birne", "Birnen", 0], ["skyr", "Skyr", 1], ["hafer", "Haferdrink", 1], ["tom", "Passierte Tomaten", 1], ["tm", "Tomatenmark", 1], ["pet", "Petersilie", 0], ["kiwi", "Gold Kiwis", 1], ["salat", "Salat", 1]]
  .forEach(([id, n, d], i) => ins.run(id, n, "supermarkt", "", d, d ? null : "2026-11-14T0" + i + ":00:00Z", d ? "2026-11-13T0" + i + ":00:00Z" : null, "x", 2, ""));

// Beispiel-Bon als PDF (Aufbau wie ein Penny-eBon)
const BON = ["*** PENNY-MARKT GMBH ***", "*** 50354 Hürth ***", "EUR", "BIO KOERN.FRISCH 2,90 B", "2 Stk x 1,45", "Birnen lose 0,55 B", "0,184 kg x 2,99 EUR/kg",
  "Petersilie glatt 1,49 B", "HAFERDR. BARISTA 12,53 A", "7 Stk x 1,79", "SKYR 1,49 B", "Passierte Tomate 0,69 B", "PENNY Tasche 0,25 A", "--------", "SUMME EUR 19,90",
  "Geg. VISA EUR 19,90", "03.11.2026 15:48 Bon-Nr.:6558"];
{
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Courier); const page = pdf.addPage([300, 520]);
  BON.forEach((t, i) => page.drawText(t, { x: 14, y: 500 - i * 14, size: 9, font }));
  writeFileSync("/tmp/bon-test.pdf", await pdf.save());
}
// Beispiel-Foto: ein langer heller Streifen (Inhalt egal, die Bilderkennung ist nachgebaut)
{
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("python3", ["-c", "from PIL import Image,ImageDraw\nim=Image.new('RGB',(400,2600),'white')\nd=ImageDraw.Draw(im)\nfor y in range(20,2600,40): d.text((20,y),'Zeile %d   1,29 A'%y,fill='black')\nim.save('/tmp/bon-test.jpg')"]); }
  catch (e) { console.log("Hinweis: kein Testbild erzeugt"); }
}

const server = createServer(async (req, res) => {
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
  const h = new Headers(); for (const [k, v] of Object.entries(req.headers)) h.set(k, v);
  const r = await worker.fetch(new Request("http://127.0.0.1:8789" + req.url, { method: req.method, headers: h, body }), { DB, ASSETS, AI, STAGE: "test", OFFERS_FETCH });
  const out = {}; r.headers.forEach((v, k) => out[k] = v); out["set-cookie"] = (out["set-cookie"] || "").replace("; Secure", "");
  if (!out["set-cookie"]) delete out["set-cookie"];
  res.writeHead(r.status, out); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8789);

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error" && !/409/.test(m.text())) errors.push(m.text()); });
page.on("dialog", d => d.accept());
const ok = (c, m) => { if (!c) { console.log("FEHLER:", m); process.exitCode = 1; } else console.log("ok:", m); };

try {
  await page.goto("http://127.0.0.1:8789/");
  await page.fill("input[name=passwort]", "geheim123"); await page.click("button[type=submit]");
  await page.waitForSelector(".row");
  await page.click("[data-me=Jonas]");
  ok(await page.locator("#testbadge").isVisible(), "TEST-Leiste sichtbar");
  await page.click("[data-act=receipts]");
  await page.waitForSelector("#rc_file", { state: "attached" });
  ok((await page.locator(".empty", { hasText: "Noch keine Kassenzettel" }).count()) === 1, "leere Kassenzettel-Liste");
  await page.screenshot({ path: "/tmp/kz-1.png" });

  // PDF hochladen
  await page.setInputFiles("#rc_file", "/tmp/bon-test.pdf");
  await page.waitForSelector(".rline", { timeout: 15000 });
  const raws = await page.locator(".rline .rraw").allTextContents();
  ok(raws.join("|") === "BIO KOERN.FRISCH|Birnen lose|Petersilie glatt|HAFERDR. BARISTA|SKYR|Passierte Tomate|PENNY Tasche", "Zeilen aus dem PDF: " + raws.join("|"));
  ok((await page.locator("#rc_shops button.on").textContent()) === "Penny", "Geschäft Penny erkannt");
  ok((await page.inputValue("#rc_at")) === "2026-11-03T15:48", "Datum erkannt");
  ok((await page.locator(".okc").count()) === 1, "Summe passt");
  const asg = await page.locator(".rline .asg").allTextContents();
  ok(asg.join("|") === "zuordnen …|→ Birnen ?|→ Petersilie ?|→ Haferdrink ?|→ Skyr ?|→ Passierte Tomaten ?|Tasche", "Vorschläge: " + asg.join("|"));
  ok((await page.locator(".rtick", { hasText: "2 Sachen" }).count()) === 1, "2 Sachen von der Liste werden abgehakt (Birnen, Petersilie)");
  await page.screenshot({ path: "/tmp/kz-2.png", fullPage: true });

  // erste Zeile: neuen Artikel anlegen
  await page.click(".rline[data-ix='0']");
  await page.fill("#ln_q", "Körniger Frischkäse");
  await page.click(".pick.new");
  ok((await page.locator(".rline[data-ix='0'] .asg").textContent()) === "＋ neu: Körniger Frischkäse", "neuer Artikel vorgemerkt");
  // Petersilie: Preis korrigieren und Vorschlag bestätigen
  await page.click(".rline[data-ix='2']");
  await page.fill("#ln_price", "1,39"); await page.click("#ln_ok");
  ok((await page.locator(".rline[data-ix='2'] .rp").textContent()) === "1,39 €" && (await page.locator(".rline[data-ix='2'] .asg").textContent()) === "→ Petersilie", "Preis korrigiert, Vorschlag bestätigt");
  // Skyr umhängen über die Suche: auf Tomatenmark und zurück ignorieren
  await page.click(".rline[data-ix='4']");
  await page.click("#ln_ign");
  ok((await page.locator(".rline[data-ix='4'] .asg").textContent()) === "ignoriert", "Zeile ignoriert");
  await page.screenshot({ path: "/tmp/kz-3.png", fullPage: true });
  await page.click("[data-rc=save]");
  await page.waitForSelector(".rcrow", { timeout: 5000 });
  ok((await page.locator(".rcrow").count()) === 1 && /Penny/.test(await page.locator(".rcrow").textContent()) && /19,90/.test(await page.locator(".rcrow").textContent()), "Kassenzettel in der Liste");
  ok(db.prepare("SELECT done FROM items WHERE id='birne'").get().done === 1 && db.prepare("SELECT done FROM items WHERE id='pet'").get().done === 1, "Birnen und Petersilie abgehakt");
  ok(db.prepare("SELECT COUNT(*) n FROM items WHERE name='Körniger Frischkäse' AND done=1 AND shop='Penny'").get().n === 1, "neuer Artikel angelegt");
  ok(db.prepare("SELECT price FROM receipt_lines WHERE item_id='pet'").get().price === 139, "korrigierter Preis gespeichert");
  ok(db.prepare("SELECT item_id FROM receipt_alias WHERE raw_key='skyr'").get().item_id === "-", "Ignorieren gelernt");
  await page.screenshot({ path: "/tmp/kz-4.png" });

  // Einzelansicht
  await page.click(".rcrow");
  await page.waitForSelector("div.rline");
  ok((await page.locator("div.rline").count()) === 7, "Einzelansicht mit 7 Zeilen");
  await page.screenshot({ path: "/tmp/kz-5.png", fullPage: true });
  await page.click("[data-rc=list]");

  // nochmal dasselbe PDF: Zuordnungen sind gelernt, Speichern wird als doppelt abgelehnt
  await page.setInputFiles("#rc_file", "/tmp/bon-test.pdf");
  await page.waitForSelector(".rline");
  const asg2 = await page.locator(".rline .asg").allTextContents();
  ok(asg2[0] === "→ Körniger Frischkäse" && asg2[4] === "ignoriert" && asg2[1] === "→ Birnen", "beim zweiten Mal gelernt: " + asg2.join("|"));
  await page.click("[data-rc=save]"); await page.waitForTimeout(400);
  ok(/schon gespeichert/.test(await page.locator("#toast").textContent()), "doppelter Bon wird erkannt");
  await page.click(".acts [data-rc=cancel]"); await page.waitForTimeout(200);

  // Foto (nachgebaute Bilderkennung): langes Bild wird in Abschnitte geteilt
  if (existsSync("/tmp/bon-test.jpg")) {
    await page.setInputFiles("#rc_file", "/tmp/bon-test.jpg");
    await page.waitForSelector(".rline", { timeout: 15000 });
    ok(aiCalls >= 2, "langes Foto in " + aiCalls + " Abschnitte geteilt");
    ok((await page.locator(".alert", { hasText: "Vom Foto abgeschrieben" }).count()) === 1, "Hinweis: vom Foto");
    ok((await page.locator("#rc_shops button.on").textContent()) === "Lidl", "Lidl erkannt");
    const a3 = await page.locator(".rline .asg").allTextContents();
    ok(a3.join("|").startsWith("→ Gold Kiwis ?|→ Salat ?"), "Vorschläge Foto: " + a3.join("|"));
    await page.screenshot({ path: "/tmp/kz-6.png", fullPage: true });
    await page.click(".acts [data-rc=cancel]");
  }

  // Preise im Bearbeiten-Dialog
  await page.click("[data-rc=close]");
  await page.waitForSelector(".hist button");
  const chip = page.locator(".hist button", { hasText: "Petersilie" });
  await chip.dispatchEvent("pointerdown"); await page.waitForTimeout(700); await chip.dispatchEvent("pointerup");
  await page.waitForSelector(".prow", { timeout: 3000 });
  ok(/Penny/.test(await page.locator(".prow").first().textContent()) && /1,39 €/.test(await page.locator(".prow").first().textContent()), "Preis im Bearbeiten-Dialog: " + await page.locator(".prow").first().textContent());
  await page.screenshot({ path: "/tmp/kz-7.png" });

  /* ---------- Angebote, Ladenvergleich, Preisverlauf, Preiswecker, Ausgaben ---------- */
  const d = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO settings (key,value) VALUES ('offers_config',?)").run(JSON.stringify({ zip: "50354", shops: ["Lidl", "Penny"], zipByShop: {} }));
  db.prepare("UPDATE items SET done=0, added_at=? WHERE id IN ('birne','pet','tm','hafer')").run(new Date().toISOString());
  db.prepare("UPDATE settings SET value = CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='rev'").run();
  const io = db.prepare("INSERT INTO offers (item_id,offer_id,shop,title,brand,price,old_price,ref_price,ref_unit,amount,bio,valid_from,valid_to,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  io.run("pet", "o1", "Lidl", "Petersilie glatt", "", 89, 129, null, "", "1 Bund", 0, d(-1), d(4), "x");
  io.run("tm", "o2", "Lidl", "Tomatenmark", "Baresa", 59, 89, 295, "kg", "200 g", 0, d(-1), d(4), "x");
  io.run("tm", "o3", "Lidl", "Bio Tomatenmark", "", 79, null, 395, "kg", "200 g", 1, d(-1), d(4), "x");
  io.run("tm", "o4", "Penny", "Tomatenmark", "", 69, null, null, "", "", 0, d(2), d(8), "x");
  io.run("hafer", "o7", "Aldi", "Bio-Haferdrink", "My Vay", 90, null, 90, "l", "1 l", 1, d(-1), d(4), "x");
  io.run("hafer", "o8", "Rewe", "Vegan Haferdrink Barista Edition", "Oatly", 179, null, 179, "l", "1 l", 0, d(-1), d(4), "x");
  io.run("hafer", "o9", "Penny", "Haferdrink Barista", "", 119, null, 119, "l", "1 l", 0, d(-1), d(4), "x");
  io.run("pet", "o10", "Lidl", "Petersilie glatt Topf", "", 99, null, null, "", "", 0, d(-1), d(4), "x");
  io.run("skyr", "o6", "Penny", "Skyr", "", 99, 149, 198, "kg", "500 g", 0, d(-1), d(4), "x");
  io.run("tm", "o5", "Lidl", "Tomatenmark Großpackung", "", 129, null, 258, "kg", "500 g", 0, d(-1), d(4), "x");
  io.run("pet", "o0", "Penny", "Petersilie", "", 79, null, null, "", "", 0, "2026-10-01", "2026-10-05", "x");
  const nowIso = new Date().toISOString();
  db.prepare("INSERT INTO offer_watch (item_id,query,checked_at,search) VALUES ('pet','',?,1),('tm','',?,1),('birne','',?,1),('hafer','',?,1)").run(nowIso, nowIso, nowIso, nowIso);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(4500);   // Liste aktualisiert sich
  await page.evaluate(() => window.Prices.load(true)); await page.waitForTimeout(500);
  const rowTm = page.locator(".row", { hasText: "Tomatenmark" });
  ok(/Lidl 1,29 €/.test(await rowTm.textContent()) && (await rowTm.locator(".ofi svg").count()) === 1, "Hinweis in der Liste mit Markierung (bester Grundpreis): " + (await rowTm.locator(".d").textContent()));
  await page.screenshot({ path: "/tmp/pr-1.png" });
  await page.click("[data-act=prices]");
  await page.waitForSelector(".ofcard");
  ok((await page.locator(".ofcard").count()) === 3, "3 Kärtchen (nur Sachen auf der Liste)");
  const haf = await page.locator(".ofcard", { hasText: "Haferdrink" }).locator(".ofr").allTextContents();
  ok(haf.length === 3 && /^Penny Haferdrink Barista schon gekauft/.test(haf[0]) && haf.filter(t => /schon gekauft/.test(t)).length === 1, "schon gekaufte Sorte (gleiches Geschäft) zuerst, Oatly bei Rewe nicht: " + haf.join(" | "));
  const pe = await page.locator(".ofcard", { hasText: "Petersilie" }).locator(".ofr").allTextContents();
  ok(pe.length === 2 && pe.every(t => !/schon gekauft/.test(t)), "Petersilie bei Penny gekauft, Angebote nur bei Lidl → kein „schon gekauft“");
  ok((await page.locator(".sec", { hasText: "Schon mal gekauft" }).count()) === 0, "kein Abschnitt für schon Gekauftes");
  const tmRows = await page.locator(".ofcard", { hasText: "Tomatenmark" }).locator(".ofl b + *").allTextContents().catch(() => []);
  const tmTitles = await page.locator(".ofcard", { hasText: "Tomatenmark" }).locator(".ofl").allTextContents();
  ok(/Großpackung/.test(tmTitles[0]) && /Baresa/.test(tmTitles[1]) && /Bio Tomatenmark/.test(tmTitles[2]), "Reihenfolge nach Grundpreis: " + tmTitles.map(t => t.slice(0, 30)).join(" | "));
  ok(/2,58 €\/kg/.test(await page.locator(".ofcard", { hasText: "Tomatenmark" }).textContent()), "Grundpreis wird angezeigt");
  ok(/ab Do|ab Mo|ab Di|ab Mi|ab Fr|ab Sa|ab So/.test(await page.locator(".ofcard", { hasText: "Tomatenmark" }).textContent()), "kommendes Angebot mit „ab …“");
  ok(/Ohne Angebot:.*Birnen/.test(await page.locator("#app").textContent()), "Birnen ohne Angebot");
  await page.screenshot({ path: "/tmp/pr-2.png", fullPage: true });
  await page.click("[data-pr=tab][data-k=compare]");
  await page.waitForSelector(".cmprow");
  const cmp = await page.locator(".cmprow").allTextContents();
  // Lidl: Petersilie 0,89 (Angebot) + Tomatenmark 1,29 (bester Grundpreis) + Birnen geschätzt 0,55 → ~2,73; Penny: Birnen 0,55 + Petersilie 1,39 (Bons) + TM geschätzt 1,29 → ~3,23
  ok(cmp.length === 2 && /^Lidl/.test(cmp[0]) && /~3,92 €/.test(cmp[0]) && /~4,42 €/.test(cmp[1]), "Ladenvergleich: " + cmp.join(" | "));
  await page.click(".cmprow >> nth=0");
  ok((await page.locator(".cmpi").count()) === 4 && (await page.locator(".cmpi.est").count()) === 2, "Details mit geschätzten Preisen");
  ok(/Günstigster Mix/.test(await page.locator("#app").textContent()), "günstigster Mix");
  await page.screenshot({ path: "/tmp/pr-3.png", fullPage: true });
  await page.click("[data-pr=tab][data-k=offers]");
  await page.click(".ofcard .ofh >> text=Petersilie");
  await page.waitForSelector("#pv_q");
  ok((await page.locator("#e_prices .ofr").count()) === 2 && (await page.locator("#e_prices .prow").count()) === 1, "Bearbeiten: Angebot und bezahlter Preis");
  ok(await page.locator("label.sw.on", { hasText: "Angebote suchen" }).count() === 1 && /An/.test(await page.locator("label.sw.on .swst").first().textContent()), "Schalter „Angebote suchen“ sichtbar an");
  await page.click("label.sw:has(#pv_al)"); await page.waitForSelector("#pv_max");
  ok(await page.locator("label.sw.on", { hasText: "Preiswecker" }).count() === 1, "Preiswecker sichtbar an");
  await page.fill("#pv_max", "0,99"); await page.press("#pv_max", "Tab"); await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/pr-dialog.png", fullPage: true });
  const wr = db.prepare("SELECT alarm, alarm_max, alarm_person FROM offer_watch WHERE item_id='pet'").get();
  ok(wr.alarm === 1 && wr.alarm_max === 99 && wr.alarm_person === "Jonas", "Preiswecker gespeichert");
  await page.click("#pv_open");
  await page.waitForSelector(".pvsvg");
  ok((await page.locator(".pvsvg circle").count()) === 1 && (await page.locator(".pvsvg line[stroke-width='4']").count()) === 3, "Preisverlauf: 1 Bon, 3 Angebote");
  ok((await page.locator(".pvleg span").count()) === 2, "Legende mit 2 Geschäften");
  await page.screenshot({ path: "/tmp/pr-4.png" });
  await page.click("#pv_x");
  ok((await page.locator(".ofcard", { hasText: "Petersilie" }).locator(".ofh .ofi").count()) === 1, "Preiswecker-Glocke im Kärtchen");
  await page.click("[data-pr=close]");
  // Ausgaben in der Statistik
  await page.click("[data-act=stats]");
  await page.waitForSelector(".spend");
  ok(/0,00 €/.test(await page.locator(".spend").textContent()) && /Schnitt 20 €/.test(await page.textContent("#sptip")), "Ausgaben: diese Woche nichts, Schnitt " + await page.textContent("#sptip"));
  await page.click("[data-st=range][data-k=month]"); await page.waitForTimeout(200);
  ok(/19,90 €/.test(await page.locator(".spend").textContent()), "Ausgaben im Monat: " + await page.locator(".spend").textContent());
  ok((await page.locator(".card-s", { hasText: "Pro Woche" }).locator(".vb").count()) === 12, "12 Wochen-Balken");
  const bought = page.locator(".card-s", { hasText: "Laut Kassenzettel gekauft" });
  const bl = await bought.locator(".bl").allTextContents();
  ok(bl.length === 5 && /^Haferdrink.*7 Stück.*12,53 €$/.test(bl[0]) && bl.some(t => /^Petersilie.*1,39 €$/.test(t)) && !bl.some(t => /SKYR/.test(t)), "laut Kassenzettel gekauft: " + bl.join(" | "));
  await bought.locator("[data-st=bsort][data-k=name]").click();
  ok(/^Birnen/.test((await page.locator(".card-s", { hasText: "Laut Kassenzettel gekauft" }).locator(".bl").first().textContent())), "Sortierung A–Z");
  await page.screenshot({ path: "/tmp/pr-5.png" });
  // Knopf „Neue Angebote suchen“
  await page.click("[data-st=close], .backbtn"); await page.waitForTimeout(200);
  await page.click("[data-act=prices]"); await page.waitForSelector("#pr_refresh");
  await page.click("#pr_refresh");
  await page.waitForFunction(() => /neuesten Stand|konnten nicht/.test(document.getElementById("toast").textContent), null, { timeout: 8000 });
  ok(/neuesten Stand/.test(await page.textContent("#toast")) && mgCalls >= 4, "Neue Angebote gesucht (" + mgCalls + " Anfragen): " + await page.textContent("#toast"));
} catch (e) { console.log("FEHLER:", e.message); process.exitCode = 1; await page.screenshot({ path: "/tmp/kz-fehler.png", fullPage: true }); }
ok(!errors.length, "keine Fehler im Browser" + (errors.length ? ": " + errors.join(" / ") : ""));
await browser.close(); server.close();
