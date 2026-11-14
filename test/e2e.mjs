// Klicktest im echten Browser (nur lokal, nicht Teil von npm test):
//   node --experimental-sqlite --no-warnings test/e2e.mjs
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import worker, { pbkdf2 } from "../src/index.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("../d1-schema.sql", import.meta.url), "utf8"));
const run = (sql, args) => { const p = db.prepare(sql); if (/returning/i.test(sql)) return { results: p.all(...args) }; p.run(...args); return { results: [] }; };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a), all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) ?? null, run: async () => run(sql, args) });
const DB = { prepare: s => stmt(s), batch: async l => l.map(s => run(s.sql, s.args)) };
const types = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", png: "image/png", webmanifest: "application/manifest+json" };
const ASSETS = { fetch: async req => { let p = new URL(req.url).pathname; if (p === "/") p = "/index.html"; const f = new URL("../public" + p, import.meta.url);
  return existsSync(f) ? new Response(readFileSync(f), { headers: { "Content-Type": types[p.split(".").pop()] || "application/octet-stream" } }) : new Response("nicht da", { status: 404 }); } };

const salt = "00112233445566778899aabbccddeeff";
db.prepare("INSERT INTO settings (key,value) VALUES ('pw_salt',?),('pw_hash',?),('session_secret',?),('rev','1'),('stores',?)").run(salt, await pbkdf2("geheim123", salt), "cd".repeat(32),
  JSON.stringify([{ id: "supermarkt", name: "Supermarkt", labels: ["Aldi", "Edeka"] }, { id: "drogerie", name: "Drogerie", labels: ["dm", "Rossmann"] }, { id: "baumarkt", name: "Baumarkt" }]));
const ins = db.prepare("INSERT INTO items (id,name,store,note,done,added_at,done_at,updated_at,buy_count,added_by) VALUES (?,?,?,?,?,?,?,?,?,?)");
[["a", "Skyr", "supermarkt", "", 0, 0, "Clara"], ["b", "Maggi", "supermarkt", "", 0, 0, ""], ["c", "Haferflocken", "supermarkt", "", 1, 2, ""], ["d", "Bananen", "supermarkt", "", 1, 5, ""],
 ["f", "Kartoffeln", "supermarkt", "", 1, 1, ""], ["e", "Zahnpasta", "drogerie", "", 0, 0, ""], ["g", "Duschgel", "drogerie", "", 1, 3, ""]]
  .forEach(([id, n, s, no, d, bc, by], i) => ins.run(id, n, s, no, d, d ? null : "2026-11-14T0" + i + ":00:00Z", d ? "2026-11-13T0" + i + ":00:00Z" : null, "x", bc, by));

const server = createServer(async (req, res) => {
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
  const h = new Headers(); for (const [k, v] of Object.entries(req.headers)) h.set(k, v);
  const r = await worker.fetch(new Request("http://127.0.0.1:8788" + req.url, { method: req.method, headers: h, body }), { DB, ASSETS });
  const out = {}; r.headers.forEach((v, k) => out[k] = v); out["set-cookie"] = (out["set-cookie"] || "").replace("; Secure", "");
  if (!out["set-cookie"]) delete out["set-cookie"];
  res.writeHead(r.status, out); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8788);

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
const ok = (c, m) => { if (!c) { console.log("FEHLER:", m); process.exitCode = 1; } else console.log("ok:", m); };

await page.goto("http://127.0.0.1:8788/");
await page.fill("input[name=passwort]", "geheim123"); await page.click("button[type=submit]");
await page.waitForSelector(".row");
ok((await page.locator(".row").count()) === 2, "2 offene Einträge im Supermarkt");
ok((await page.locator(".whobox").count()) === 1, "Frage „Wer benutzt dieses Handy?“");
await page.click("[data-me=Jonas]"); await page.waitForTimeout(200);
ok((await page.locator(".whobox").count()) === 0, "Jonas gewählt");
ok((await page.locator(".grp").allTextContents()).join("|").startsWith("Kühlregal|Gewürze"), "offen nach Warengruppe: " + (await page.locator(".grp").allTextContents()).join("|"));
ok((await page.locator(".row .by", { hasText: "von Clara" }).count()) === 1, "Skyr zeigt „von Clara“");
const histNames = async () => (await page.locator(".hist button").allTextContents()).map(t => t.replace(/\d+×$/, ""));
ok((await histNames()).join(",") === "Bananen,Haferflocken,Kartoffeln", "gekauft nach Häufigkeit: " + (await histNames()).join(","));
await page.click("[data-sort=hist][data-k=group]"); await page.waitForTimeout(100);
ok((await histNames()).join(",") === "Bananen,Kartoffeln,Haferflocken", "gekauft nach Warengruppe: " + (await histNames()).join(","));
await page.click("[data-sort=hist][data-k=freq]"); await page.click("[data-sort=open][data-k=new]"); await page.waitForTimeout(100);
ok((await page.locator(".grp").count()) === 0 && (await page.locator(".row .n").first().textContent()) === "Maggi", "offen nach Neueste: " + (await page.locator(".grp").count()) + " " + (await page.locator(".row .n").allTextContents()).join(","));
await page.click("[data-sort=open][data-k=group]");
await page.screenshot({ path: "/tmp/e2e-1.png" });

await page.fill("#q", "Butter"); await page.press("#q", "Enter");
await page.waitForTimeout(300);
ok((await page.locator(".row .n", { hasText: "Butter" }).count()) === 1, "Butter hinzugefügt");
await page.fill("#q", "haf");
ok((await page.locator("#sugg button", { hasText: "Haferflocken" }).count()) === 1, "Vorschlag Haferflocken");
await page.click("#sugg button"); await page.waitForTimeout(300);
ok((await page.locator(".row .n", { hasText: "Haferflocken" }).count()) === 1, "Vorschlag übernommen");

await page.click(".row .tick >> text=Skyr"); await page.waitForTimeout(600);
ok(db.prepare("SELECT buy_count FROM items WHERE id='a'").get().buy_count === 1, "Abhaken zählt Häufigkeit hoch");
ok((await page.locator(".row .n", { hasText: "Skyr" }).count()) === 0, "Skyr abgehakt");
ok((await page.locator(".hist button", { hasText: "Skyr" }).count()) === 1, "Skyr unter „Schon mal gekauft“");

await page.click("[data-store=drogerie]");
ok((await page.locator(".row .n", { hasText: "Zahnpasta" }).count()) === 1, "Drogerie zeigt Zahnpasta");
await page.click("[data-store=supermarkt]");

// Datenbank prüfen: Änderungen sind wirklich gespeichert
await page.waitForTimeout(500);
const rows = db.prepare("SELECT name, done FROM items WHERE store='supermarkt' ORDER BY name").all();
ok(rows.find(r => r.name === "Butter")?.done === 0, "Butter in der Datenbank");
ok(db.prepare("SELECT added_by FROM items WHERE name='Butter'").get().added_by === "Jonas", "Butter: eingetragen von Jonas");
ok(rows.find(r => r.name === "Skyr")?.done === 1, "Skyr in der Datenbank abgehakt");

// zweites Gerät sieht die Änderung
const page2 = await (await browser.newContext({ storageState: await ctx.storageState(), viewport: { width: 390, height: 844 } })).newPage();
await page2.goto("http://127.0.0.1:8788/"); await page2.waitForSelector(".row");
ok((await page2.locator(".row .n", { hasText: "Butter" }).count()) === 1, "zweites Gerät sieht Butter");
await page2.fill("#q", "Eier"); await page2.press("#q", "Enter");
await page.waitForTimeout(5500);
ok((await page.locator(".row .n", { hasText: "Eier" }).count()) === 1, "erstes Gerät bekommt „Eier“ automatisch");

// Labels: „Brezel @Edeka @Aldi“ → zwei Labels; Filter zeigt nur Einträge mit passendem Label
await page.fill("#q", "Brezel @edeka @Aldi"); await page.press("#q", "Enter"); await page.waitForTimeout(400);
await page.fill("#q", "Senf @Edeka"); await page.press("#q", "Enter"); await page.waitForTimeout(400);
ok(db.prepare("SELECT shop FROM items WHERE name='Brezel'").get()?.shop === "Edeka|Aldi", "„Brezel @edeka @Aldi“ → zwei Labels");
ok((await page.locator(".row", { hasText: "Brezel" }).locator(".shop").count()) === 2, "beide Labels am Eintrag sichtbar");
const names = async () => (await page.locator(".row .n").allTextContents()).map(t => t.replace(/(Edeka|Aldi)/g, "")).sort().join(",");
await page.click("[data-filter=Aldi]"); await page.waitForTimeout(150);
ok(await names() === "Brezel", "Filter Aldi: nur Brezel – " + await names());
await page.click("[data-filter=Edeka]"); await page.waitForTimeout(150);
ok(await names() === "Brezel,Senf", "Filter Aldi + Edeka: Brezel und Senf – " + await names());
ok(/Nur Sachen mit Label Aldi oder Edeka/.test(await page.textContent("#app")), "Hinweis zum Filter");
await page.screenshot({ path: "/tmp/e2e-labels.png" });
await page.click("[data-filter=Aldi]"); await page.click("[data-filter=Edeka]"); await page.waitForTimeout(150);
ok((await page.locator(".row").count()) >= 5, "beide Filter wieder aus → alles sichtbar");
await page.click("[data-filter=Aldi]"); await page.click("[data-filter='']"); await page.waitForTimeout(150);
ok((await page.locator(".shopbar button.on").textContent()) === "Alle", "„Alle“ setzt Filter zurück");

// Bearbeiten
await page.locator(".row", { hasText: "Butter" }).locator(".more").click();
await page.click("#e_sh [data-sh=Aldi]"); await page.click("#e_sh [data-sh=Edeka]");
await page.fill("#e_note", "Kerrygold"); await page.selectOption("#e_cat", "sonst"); await page.click("#e_ok"); await page.waitForTimeout(400);
ok(db.prepare("SELECT cat FROM items WHERE name='Butter'").get().cat === "sonst", "Warengruppe von Hand geändert");
ok(db.prepare("SELECT shop FROM items WHERE name='Butter'").get().shop === "Aldi|Edeka", "zwei Labels im Dialog gesetzt");
ok((await page.locator(".grp").allTextContents()).includes("Sonstiges"), "Abschnitt „Sonstiges“ erscheint");
ok((await page.locator(".row .d", { hasText: "Kerrygold" }).count()) === 1, "Notiz gespeichert");
await page.screenshot({ path: "/tmp/e2e-2.png" });
await page.click("[data-act=menu]"); await page.waitForTimeout(600);
ok(/Benachrichtigungen einschalten|keine Benachrichtigungen|Home-Bildschirm/.test(await page.locator("#pushbox").textContent()), "Benachrichtigungs-Bereich: " + (await page.locator("#pushbox").textContent()).slice(0, 60));
ok((await (await fetch("http://127.0.0.1:8788/sw.js")).status) === 200, "Service Worker ohne Anmeldung abrufbar");
await page.screenshot({ path: "/tmp/e2e-3.png" });
await page.click("#m_st"); await page.waitForTimeout(200);
await page.fill("input[data-lx='2']", "Obi, Hornbach"); await page.click("#s_ok"); await page.waitForTimeout(600);
ok(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='stores'").get().value)[2].labels.join() === "Obi,Hornbach", "Labels für Baumarkt angelegt");

// Sortierung „Schon mal gekauft“: jeder Laden merkt sich seine eigene
const histMode = async p => p.locator(".mini-seg button.on[data-sort=hist]").getAttribute("data-k");
await page.click("[data-store=supermarkt]"); await page.waitForTimeout(150);
await page.click("[data-sort=hist][data-k=group]"); await page.waitForTimeout(150);
await page.click("[data-store=drogerie]"); await page.waitForTimeout(150);
await page.click("[data-sort=hist][data-k=freq]"); await page.waitForTimeout(150);
ok(await histMode(page) === "freq", "Drogerie: Häufigkeit");
await page.click("[data-store=supermarkt]"); await page.waitForTimeout(150);
ok(await histMode(page) === "group", "Supermarkt behält Warengruppe, obwohl Drogerie auf Häufigkeit steht");
await page.click("[data-store=drogerie]"); await page.waitForTimeout(150);
await page.click("[data-sort=hist][data-k=group]"); await page.click("[data-sort=hist][data-k=freq]"); await page.waitForTimeout(150);
await page.click("[data-store=supermarkt]"); await page.waitForTimeout(5000);
ok(await histMode(page) === "group", "… auch nach dem Abgleich mit dem Server");
await page.reload(); await page.waitForSelector(".hist"); await page.waitForTimeout(300);
ok(await histMode(page) === "group", "… und nach dem Neuladen (Supermarkt)");
await page.click("[data-store=drogerie]"); await page.waitForTimeout(150);
ok(await histMode(page) === "freq", "… und nach dem Neuladen (Drogerie)");
await page.evaluate(() => localStorage.removeItem("einkaufsliste.v1")); await page.reload(); await page.waitForSelector(".hist"); await page.waitForTimeout(300);
await page.click("[data-store=supermarkt]"); await page.waitForTimeout(150);
ok(await histMode(page) === "group", "… und ohne Listen-Zwischenspeicher");

ok(errors.length === 0, "keine Fehler in der Browser-Konsole " + errors.join(" | "));
await browser.close(); server.close();
