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
const types = { html: "text/html; charset=utf-8", js: "text/javascript", png: "image/png", webmanifest: "application/manifest+json" };
const ASSETS = { fetch: async req => { let p = new URL(req.url).pathname; if (p === "/") p = "/index.html"; const f = new URL("../public" + p, import.meta.url);
  return existsSync(f) ? new Response(readFileSync(f), { headers: { "Content-Type": types[p.split(".").pop()] || "application/octet-stream" } }) : new Response("nicht da", { status: 404 }); } };

const salt = "00112233445566778899aabbccddeeff";
db.prepare("INSERT INTO settings (key,value) VALUES ('pw_salt',?),('pw_hash',?),('session_secret',?),('rev','1'),('stores',?)").run(salt, await pbkdf2("geheim123", salt), "cd".repeat(32),
  JSON.stringify([{ id: "supermarkt", name: "Supermarkt" }, { id: "drogerie", name: "Drogerie" }, { id: "baumarkt", name: "Baumarkt" }]));
const ins = db.prepare("INSERT INTO items (id,name,store,note,done,added_at,done_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
[["a", "Skyr", "supermarkt", "", 0], ["b", "Maggi", "supermarkt", "", 0], ["c", "Haferflocken", "supermarkt", "", 1], ["d", "Bananen", "supermarkt", "", 1], ["e", "Zahnpasta", "drogerie", "", 0]]
  .forEach(([id, n, s, no, d], i) => ins.run(id, n, s, no, d, d ? null : "2026-11-14T0" + i + ":00:00Z", d ? "2026-11-13T0" + i + ":00:00Z" : null, "x"));

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
await page.screenshot({ path: "/tmp/e2e-1.png" });

await page.fill("#q", "Butter"); await page.press("#q", "Enter");
await page.waitForTimeout(300);
ok((await page.locator(".row .n", { hasText: "Butter" }).count()) === 1, "Butter hinzugefügt");
await page.fill("#q", "haf");
ok((await page.locator("#sugg button", { hasText: "Haferflocken" }).count()) === 1, "Vorschlag Haferflocken");
await page.click("#sugg button"); await page.waitForTimeout(300);
ok((await page.locator(".row .n", { hasText: "Haferflocken" }).count()) === 1, "Vorschlag übernommen");

await page.click(".row .tick >> text=Skyr"); await page.waitForTimeout(400);
ok((await page.locator(".row .n", { hasText: "Skyr" }).count()) === 0, "Skyr abgehakt");
ok((await page.locator(".hist button", { hasText: "Skyr" }).count()) === 1, "Skyr unter „Schon mal gekauft“");

await page.click("[data-store=drogerie]");
ok((await page.locator(".row .n", { hasText: "Zahnpasta" }).count()) === 1, "Drogerie zeigt Zahnpasta");
await page.click("[data-store=supermarkt]");

// Datenbank prüfen: Änderungen sind wirklich gespeichert
await page.waitForTimeout(500);
const rows = db.prepare("SELECT name, done FROM items WHERE store='supermarkt' ORDER BY name").all();
ok(rows.find(r => r.name === "Butter")?.done === 0, "Butter in der Datenbank");
ok(rows.find(r => r.name === "Skyr")?.done === 1, "Skyr in der Datenbank abgehakt");

// zweites Gerät sieht die Änderung
const page2 = await (await browser.newContext({ storageState: await ctx.storageState(), viewport: { width: 390, height: 844 } })).newPage();
await page2.goto("http://127.0.0.1:8788/"); await page2.waitForSelector(".row");
ok((await page2.locator(".row .n", { hasText: "Butter" }).count()) === 1, "zweites Gerät sieht Butter");
await page2.fill("#q", "Eier"); await page2.press("#q", "Enter");
await page.waitForTimeout(5500);
ok((await page.locator(".row .n", { hasText: "Eier" }).count()) === 1, "erstes Gerät bekommt „Eier“ automatisch");

// Bearbeiten
await page.locator(".row", { hasText: "Butter" }).locator(".more").click();
await page.fill("#e_note", "Kerrygold"); await page.click("#e_ok"); await page.waitForTimeout(300);
ok((await page.locator(".row .d", { hasText: "Kerrygold" }).count()) === 1, "Notiz gespeichert");
await page.screenshot({ path: "/tmp/e2e-2.png" });
await page.click("[data-act=menu]"); await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/e2e-3.png" });

ok(errors.length === 0, "keine Fehler in der Browser-Konsole " + errors.join(" | "));
await browser.close(); server.close();
