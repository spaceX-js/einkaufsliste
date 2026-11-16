// Testet den Worker gegen eine lokale SQLite-Datenbank, die sich wie D1 verhält.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { pbkdf2, checkItem, checkStores } from "../src/index.js";

/* ---- kleiner D1-Ersatz ---- */
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../d1-schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { return run(sql, args); }
  });
  function run(sql, args) {
    const p = db.prepare(sql);
    if (/returning/i.test(sql)) return { results: p.all(...args) };
    p.run(...args); return { results: [] };
  }
  return {
    raw: db,
    prepare: sql => stmt(sql),
    async batch(list) {
      db.exec("BEGIN");
      try { const out = list.map(s => run(s.sql, s.args)); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    }
  };
}
const ASSETS = { fetch: async req => new Response("<html>app " + new URL(req.url).pathname + "</html>", { headers: { "Content-Type": "text/html" } }) };

async function setup(pw = "geheim123") {
  const DB = makeD1();
  const salt = "00112233445566778899aabbccddeeff";
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)").run(
    "pw_salt", salt, "pw_hash", await pbkdf2(pw, salt), "session_secret", "ab".repeat(32), "rev", "1",
    "stores", JSON.stringify([{ id: "supermarkt", name: "Supermarkt" }, { id: "drogerie", name: "Drogerie" }]));
  return { DB, ASSETS };
}
const call = (env, path, opts = {}) => worker.fetch(new Request("https://x.test" + path, opts), env);
async function login(env, pw = "geheim123") {
  const fd = new FormData(); fd.set("passwort", pw);
  const res = await call(env, "/login", { method: "POST", body: fd, headers: { "CF-Connecting-IP": "1.2.3.4" } });
  const c = res.headers.get("Set-Cookie");
  return c ? c.split(";")[0] : null;
}
const post = (env, cookie, path, body) => call(env, path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (env, cookie, path) => call(env, path, { headers: { Cookie: cookie } });

test("ohne Anmeldung: Anmeldeseite, keine Daten", async () => {
  const env = await setup();
  const res = await call(env, "/");
  assert.match(await res.text(), /Bitte gib euer Passwort ein/);
  assert.equal((await call(env, "/api/state")).status, 401);
  assert.equal((await call(env, "/app.js")).status, 302);
  assert.equal((await call(env, "/icon.png")).status, 200);
});

test("falsches Passwort wird abgelehnt", async () => {
  const env = await setup();
  assert.equal(await login(env, "falsch"), null);
});

test("Eintrag anlegen, abhaken, verschieben, löschen", async () => {
  const env = await setup();
  const ck = await login(env);
  assert.ok(ck);
  let st = await (await get(env, ck, "/api/state")).json();
  assert.equal(st.items.length, 0);
  assert.equal(st.stores.length, 2);

  let r = await (await post(env, ck, "/api/item", { id: "a1", name: "  Skyr ", store: "supermarkt", done: false, addedAt: "2026-11-14T08:00:00Z" })).json();
  assert.equal(r.rev, 2);
  // gleicher Stand → nur "same"
  assert.deepEqual(await (await get(env, ck, "/api/state?rev=2")).json(), { rev: 2, same: true });
  st = await (await get(env, ck, "/api/state?rev=1")).json();
  assert.equal(st.items[0].name, "Skyr");
  assert.equal(st.items[0].done, false);

  await post(env, ck, "/api/item", { id: "a1", name: "Skyr", store: "drogerie", note: "2×", done: true, doneAt: "2026-11-14T09:00:00Z" });
  st = await (await get(env, ck, "/api/state")).json();
  assert.equal(st.items[0].store, "drogerie");
  assert.equal(st.items[0].done, true);
  assert.equal(st.items[0].note, "2×");

  r = await (await post(env, ck, "/api/item/delete", { id: "a1" })).json();
  assert.equal(r.rev, 4);
  st = await (await get(env, ck, "/api/state")).json();
  assert.equal(st.items.length, 0);
});

test("Läden speichern", async () => {
  const env = await setup();
  const ck = await login(env);
  assert.equal((await post(env, ck, "/api/stores", { list: [] })).status, 400);
  await post(env, ck, "/api/stores", { list: [{ id: "ikea", name: "IKEA" }, { id: "supermarkt", name: "Edeka" }] });
  const st = await (await get(env, ck, "/api/state")).json();
  assert.deepEqual(st.stores.map(s => s.name), ["IKEA", "Edeka"]);
});

test("ungültige Eingaben werden abgewiesen", async () => {
  assert.equal(checkItem({ id: "x y", name: "a", store: "s" }), null);
  assert.equal(checkItem({ id: "x", name: "   ", store: "s" }), null);
  assert.equal(checkItem({ id: "x", name: "a", store: "<b>" }), null);
  assert.equal(checkItem({ id: "x", name: "a".repeat(500), store: "s" }).name.length, 120);
  assert.equal(checkItem({ id: "x", name: "a", store: "s", addedAt: "kein Datum" }).addedAt, null);
  assert.equal(checkStores([{ id: "a", name: "A" }, { id: "a", name: "B" }]), null);
});

test("Passwort ändern: altes Passwort gilt danach nicht mehr", async () => {
  const env = await setup();
  const ck = await login(env);
  assert.equal((await post(env, ck, "/api/password", { old: "falsch", new: "neuesPasswort" })).status, 400);
  assert.equal((await post(env, ck, "/api/password", { old: "geheim123", new: "neuesPasswort" })).status, 200);
  assert.equal((await get(env, ck, "/api/state")).status, 401);   // alte Sitzung ungültig
  assert.equal(await login(env, "geheim123"), null);
  assert.ok(await login(env, "neuesPasswort"));
});

/* ---------- v1.1: Häufigkeit, Warengruppe, Benachrichtigungen ---------- */
import { b64u, unb64u } from "../src/push.js";

// Empfänger-Gerät simulieren: eigener Schlüssel + auth-Geheimnis, kann Nachrichten entschlüsseln
async function fakeDevice(name) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { name, kp, endpoint: "https://push.example/" + name, keys: { p256dh: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), auth: b64u(auth) }, auth };
}
async function decrypt(dev, body) {
  const b = new Uint8Array(body), salt = b.slice(0, 16), idlen = b[20], asPub = b.slice(21, 21 + idlen), ct = b.slice(21 + idlen);
  const hk = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, dev.kp.privateKey, 256));
  const uaPub = unb64u(dev.keys.p256dh), te = new TextEncoder();
  const ikm = await hk(dev.auth, shared, new Uint8Array([...te.encode("WebPush: info\0"), ...uaPub, ...asPub]), 32);
  const cek = await hk(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hk(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  assert.equal(plain[plain.length - 1], 2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}
function pushEnv(env, status = 201) {
  const sent = [];
  env.PUSH_FETCH = async (url, opts) => { sent.push({ url, opts }); return new Response(null, { status: typeof status === "function" ? status(url) : status }); };
  env.PUSH_DELAY_MS = 60;
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  return { sent, ctx, flush: () => Promise.all(waits) };
}
const postCtx = (env, ctx, cookie, path, body) => worker.fetch(new Request("https://liste.test" + path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);

test("Häufigkeit: Abhaken zählt, schnelles Zurücknehmen zählt wieder ab", async () => {
  const env = await setup(); const ck = await login(env);
  const base = { id: "h1", name: "Skyr", store: "supermarkt", by: "Jonas" };
  await post(env, ck, "/api/item", { ...base, done: false, addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { ...base, done: true, doneAt: new Date().toISOString() });
  let st = await (await get(env, ck, "/api/state")).json();
  assert.equal(st.items[0].buyCount, 1);
  assert.equal(st.items[0].addedBy, "Jonas");
  await post(env, ck, "/api/item", { ...base, done: false, addedAt: new Date().toISOString(), by: "Clara" });   // sofort zurück = Versehen
  st = await (await get(env, ck, "/api/state")).json();
  assert.equal(st.items[0].buyCount, 0);
  assert.equal(st.items[0].addedBy, "Clara");
  await post(env, ck, "/api/item", { ...base, done: true, doneAt: new Date().toISOString() });
  // abgehakt vor über 10 Minuten → wieder auf die Liste zählt NICHT ab
  env.DB.raw.prepare("UPDATE items SET done_at = '2020-01-01T00:00:00.000Z'").run();
  await post(env, ck, "/api/item", { ...base, done: false, addedAt: new Date().toISOString() });
  st = await (await get(env, ck, "/api/state")).json();
  assert.equal(st.items[0].buyCount, 1);
});

test("Warengruppe wird gespeichert, Unsinn wird verworfen", async () => {
  const env = await setup(); const ck = await login(env);
  await post(env, ck, "/api/item", { id: "w1", name: "Sumach", store: "supermarkt", cat: "gewuerz" });
  await post(env, ck, "/api/item", { id: "w2", name: "X", store: "supermarkt", cat: "<script>" });
  const st = await (await get(env, ck, "/api/state")).json();
  assert.equal(st.items.find(i => i.id === "w1").cat, "gewuerz");
  assert.equal(st.items.find(i => i.id === "w2").cat, "");
});

test("Benachrichtigung: nur der andere, Sammel-Nachricht, richtig verschlüsselt", async () => {
  const env = await setup(); const ck = await login(env);
  const { sent, ctx, flush } = pushEnv(env);
  const jonas = await fakeDevice("jonas"), clara = await fakeDevice("clara");
  const key = (await (await get(env, ck, "/api/push/key")).json()).key;
  assert.equal(unb64u(key).length, 65);
  for (const [d, p] of [[jonas, "Jonas"], [clara, "Clara"]])
    assert.equal((await post(env, ck, "/api/push/subscribe", { endpoint: d.endpoint, keys: d.keys, person: p })).status, 200);
  assert.equal((await post(env, ck, "/api/push/subscribe", { endpoint: "http://unsicher", keys: jonas.keys, person: "Jonas" })).status, 400);

  // Jonas trägt drei Sachen kurz hintereinander ein
  const t0 = Date.now();
  await postCtx(env, ctx, ck, "/api/item", { id: "n1", name: "Skyr", store: "supermarkt", addedAt: new Date(t0).toISOString(), by: "Jonas" });
  await postCtx(env, ctx, ck, "/api/item", { id: "n2", name: "Maggi", store: "supermarkt", addedAt: new Date(t0 + 1).toISOString(), by: "Jonas" });
  await postCtx(env, ctx, ck, "/api/item", { id: "n3", name: "Zahnpasta", store: "drogerie", addedAt: new Date(t0 + 2).toISOString(), by: "Jonas" });
  await flush();
  assert.equal(sent.length, 1, "genau eine Sammel-Nachricht");
  assert.equal(sent[0].url, clara.endpoint, "nur an Clara");
  const msg = await decrypt(clara, sent[0].opts.body);
  assert.equal(msg.title, "Jonas hat 3 Sachen eingetragen");
  assert.equal(msg.body, "Supermarkt: Skyr, Maggi · Drogerie: Zahnpasta");
  assert.equal(sent[0].opts.headers["Content-Encoding"], "aes128gcm");

  // VAPID-Signatur prüfen
  const m = sent[0].opts.headers.Authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  const claims = JSON.parse(new TextDecoder().decode(unb64u(m[2])));
  assert.equal(claims.aud, "https://push.example");
  assert.equal(claims.sub, "https://liste.test");
  const pub = await crypto.subtle.importKey("raw", unb64u(m[4]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(m[3]), new TextEncoder().encode(m[1] + "." + m[2])));

  // Abhaken löst keine Nachricht aus
  await postCtx(env, ctx, ck, "/api/item", { id: "n1", name: "Skyr", store: "supermarkt", done: true, doneAt: new Date().toISOString(), by: "Clara" });
  await flush();
  assert.equal(sent.length, 1);
});

test("Benachrichtigung: abgemeldetes Gerät (410) wird entfernt", async () => {
  const env = await setup(); const ck = await login(env);
  const { sent, ctx, flush } = pushEnv(env, 410);
  const clara = await fakeDevice("clara");
  await post(env, ck, "/api/push/subscribe", { endpoint: clara.endpoint, keys: clara.keys, person: "Clara" });
  await postCtx(env, ctx, ck, "/api/item", { id: "z1", name: "Eier", store: "supermarkt", addedAt: new Date().toISOString(), by: "Jonas" });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM push_subs").get().n, 0);
});

test("Warengruppen-Erkennung", async () => {
  const code = readFileSync(new URL("../public/groups.js", import.meta.url), "utf8");
  const mod = { exports: {} }; new Function("module", code)(mod);
  const G = mod.exports, g = n => G.guessGroup(n);
  assert.equal(g("Bananen"), "obst"); assert.equal(g("Passierte Tomaten"), "vorrat"); assert.equal(g("Tomaten"), "obst");
  assert.equal(g("Geiles eis"), "tk"); assert.equal(g("Reis"), "vorrat"); assert.equal(g("Reibekäse"), "kuehl");
  assert.equal(g("Kamillentee"), "getraenke"); assert.equal(g("Olivenöl"), "vorrat"); assert.equal(g("Haarspülung"), "pflege");
  assert.equal(g("Spülmaschinentabs"), "haushalt"); assert.equal(g("Katzenfutter feucht"), "tier"); assert.equal(g("Wunschgutschein"), "sonst");
  assert.equal(G.groupOf({ name: "Sumach", cat: "obst" }), "obst");      // von Hand gewählt hat Vorrang
});

/* ---------- v1.2/1.3: Labels für einzelne Geschäfte (mehrere pro Eintrag) ---------- */
test("Labels: mehrere pro Eintrag, je Laden einstellbar", async () => {
  const env = await setup(); const ck = await login(env);
  await post(env, ck, "/api/stores", { list: [{ id: "supermarkt", name: "Supermarkt", labels: ["Aldi", " Edeka ", "aldi", ""] }, { id: "drogerie", name: "Drogerie" }] });
  let st = await (await get(env, ck, "/api/state")).json();
  assert.deepEqual(st.stores[0].labels, ["Aldi", "Edeka"], "doppelte/leere Labels entfernt");
  assert.equal(st.stores[1].labels, undefined, "Laden ohne Labels bleibt ohne");

  await post(env, ck, "/api/item", { id: "l1", name: "Brezel", store: "supermarkt", shops: ["Edeka", "Aldi", "edeka"], addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "l2", name: "Milch", store: "supermarkt", addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "l3", name: "X", store: "supermarkt", shops: ["<b>Li|dl</b>\n"] });
  await post(env, ck, "/api/item", { id: "l4", name: "Alt", store: "supermarkt", shop: "Rewe" });          // ältere Seite schickt nur „shop“
  st = await (await get(env, ck, "/api/state")).json();
  const by = id => st.items.find(i => i.id === id);
  assert.deepEqual(by("l1").shops, ["Edeka", "Aldi"], "mehrere Labels, Dubletten raus");
  assert.deepEqual(by("l2").shops, [], "ohne Label bleibt leer");
  assert.deepEqual(by("l3").shops, ["bLidl/b"], "Sonderzeichen entfernt");
  assert.deepEqual(by("l4").shops, ["Rewe"], "einzelnes Label (alte Form) wird verstanden");
  assert.equal(env.DB.raw.prepare("SELECT shop FROM items WHERE id='l1'").get().shop, "Edeka|Aldi");

  await post(env, ck, "/api/item", { id: "l1", name: "Brezel", store: "supermarkt", shops: [] });
  st = await (await get(env, ck, "/api/state")).json();
  assert.deepEqual(st.items.find(i => i.id === "l1").shops, []);
});

test("Labels: Nachricht nennt die Geschäfte", async () => {
  const { buildMessage } = await import("../src/index.js");
  const m = buildMessage("Clara", [{ name: "Brezel", store: "supermarkt", shop: "Edeka|Aldi" }, { name: "Milch", store: "supermarkt", shop: "" }], [{ id: "supermarkt", name: "Supermarkt" }]);
  assert.equal(m.body, "Supermarkt: Brezel (Edeka, Aldi), Milch");
});

/* ---------- v1.4: Statistik ---------- */
test("Statistik: jedes Abhaken wird mit Datum gespeichert, schnelle Rücknahme löscht es", async () => {
  const env = await setup(); const ck = await login(env);
  const base = { id: "p1", name: "Bananen", store: "supermarkt", shops: ["Aldi"], by: "Clara" };
  await post(env, ck, "/api/item", { ...base, done: false, addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { ...base, done: true, doneAt: new Date().toISOString() });
  let d = await (await get(env, ck, "/api/purchases")).json();
  assert.equal(d.rows.length, 1);
  assert.deepEqual(d.rows[0].slice(0, 6), ["p1", "Bananen", "supermarkt", "", "Aldi", "Clara"]);
  assert.ok(d.first);
  // gleich wieder zurück (Versehen) → Kauf weg
  await post(env, ck, "/api/item", { ...base, done: false, addedAt: new Date().toISOString() });
  d = await (await get(env, ck, "/api/purchases")).json();
  assert.equal(d.rows.length, 0);
  // zweimal richtig gekauft
  await post(env, ck, "/api/item", { ...base, done: true, doneAt: new Date().toISOString() });
  env.DB.raw.prepare("UPDATE items SET done_at = '2020-01-01T00:00:00.000Z'").run();
  env.DB.raw.prepare("UPDATE purchases SET at = '2020-01-01T00:00:00.000Z'").run();
  await post(env, ck, "/api/item", { ...base, done: false, addedAt: new Date().toISOString() });   // später wieder drauf: Kauf bleibt
  await post(env, ck, "/api/item", { ...base, done: true, doneAt: new Date().toISOString() });
  d = await (await get(env, ck, "/api/purchases?since=2000-01-01T00:00:00Z")).json();
  assert.equal(d.rows.length, 2);
  d = await (await get(env, ck, "/api/purchases?since=2025-01-01T00:00:00Z")).json();
  assert.equal(d.rows.length, 1, "since filtert");
  // Bearbeiten ohne Abhaken erzeugt keinen Kauf
  await post(env, ck, "/api/item", { ...base, done: true, note: "groß", doneAt: new Date().toISOString() });
  d = await (await get(env, ck, "/api/purchases?since=2000-01-01T00:00:00Z")).json();
  assert.equal(d.rows.length, 2);
  assert.equal((await call(env, "/api/purchases")).status, 401, "nur angemeldet");
});

/* ---------- v1.5: „… war einkaufen“ ---------- */
test("Einkauf erledigt: Zusammenfassung an den anderen, erst nach 5 Minuten Ruhe, nur einmal", async () => {
  const { announceShopping } = await import("../src/index.js");
  const env = await setup(); const ck = await login(env);
  const { sent } = pushEnv(env);
  const jonas = await fakeDevice("jonas"), clara = await fakeDevice("clara");
  await post(env, ck, "/api/push/subscribe", { endpoint: jonas.endpoint, keys: jonas.keys, person: "Jonas" });
  await post(env, ck, "/api/push/subscribe", { endpoint: clara.endpoint, keys: clara.keys, person: "Clara" });
  assert.equal(env.DB.raw.prepare("SELECT value FROM settings WHERE key='origin'").get().value, "https://x.test");
  // Jonas hakt im Supermarkt 3 Sachen und in der Drogerie 1 ab; 1 Sache bleibt im Supermarkt offen
  const add = (id, name, store) => post(env, ck, "/api/item", { id, name, store, by: "Jonas", addedAt: new Date().toISOString() });
  const tick = (id, name, store) => post(env, ck, "/api/item", { id, name, store, by: "Jonas", done: true, doneAt: new Date().toISOString() });
  for (const [id, n, st] of [["a", "Bananen", "supermarkt"], ["b", "Skyr", "supermarkt"], ["c", "Eier", "supermarkt"], ["d", "Zahnpasta", "drogerie"], ["e", "Butter", "supermarkt"]]) await add(id, n, st);
  for (const [id, n, st] of [["a", "Bananen", "supermarkt"], ["b", "Skyr", "supermarkt"], ["c", "Eier", "supermarkt"], ["d", "Zahnpasta", "drogerie"]]) await tick(id, n, st);
  sent.length = 0;

  assert.equal((await announceShopping(env)).length, 0, "noch keine 5 Minuten Ruhe → nichts");
  assert.equal(sent.length, 0);
  const later = Date.now() + 6 * 60 * 1000;
  const out = await announceShopping(env, later);
  assert.equal(out.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, clara.endpoint, "nur an Clara");
  const msg = await decrypt(clara, sent[0].opts.body);
  assert.equal(msg.title, "Jonas war einkaufen – 4 Sachen abgehakt");
  assert.equal(msg.body, "Supermarkt: Bananen, Skyr, Eier · Drogerie: Zahnpasta\nNoch offen: Supermarkt 1");
  assert.equal(new URL(JSON.parse(new TextDecoder().decode(unb64u(sent[0].opts.headers.Authorization.match(/t=[^.]+\.([^.]+)\./)[1]))).sub).origin, "https://x.test");

  assert.equal((await announceShopping(env, later + 10 * 60 * 1000)).length, 0, "nur einmal");
  assert.equal(sent.length, 1);
});

test("Einkauf erledigt: zurückgenommenes Abhaken zählt nicht, Käufe ohne Person werden nicht gemeldet", async () => {
  const { announceShopping } = await import("../src/index.js");
  const env = await setup(); const ck = await login(env);
  const { sent } = pushEnv(env);
  const clara = await fakeDevice("clara");
  await post(env, ck, "/api/push/subscribe", { endpoint: clara.endpoint, keys: clara.keys, person: "Clara" });
  await post(env, ck, "/api/item", { id: "a", name: "Bananen", store: "supermarkt", by: "Jonas", addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "a", name: "Bananen", store: "supermarkt", by: "Jonas", done: true, doneAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "a", name: "Bananen", store: "supermarkt", by: "Jonas", addedAt: new Date().toISOString() });   // Versehen
  await post(env, ck, "/api/item", { id: "b", name: "Eier", store: "supermarkt", addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "b", name: "Eier", store: "supermarkt", done: true, doneAt: new Date().toISOString() });       // ohne Person
  sent.length = 0;
  assert.equal((await announceShopping(env, Date.now() + 6 * 60 * 1000)).length, 0);
  assert.equal(sent.length, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM purchases WHERE announced = 0").get().n, 0, "trotzdem als erledigt markiert");
});

test("Einkauf erledigt: Cloudflare-Zeitsteuerung ist eingerichtet", async () => {
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(cfg, /"crons":\s*\["\*\/5 \* \* \* \*"\]/);
  assert.equal(typeof worker.scheduled, "function");
});

/* ---------- v1.6: von der Liste nehmen (nicht gekauft) ---------- */
test("Von der Liste nehmen: kein Kauf, Häufigkeit bleibt, Rückgängig zählt nicht ab", async () => {
  const env = await setup(); const ck = await login(env);
  const base = { id: "r1", name: "Skyr", store: "supermarkt", by: "Jonas" };
  const state = async () => (await (await get(env, ck, "/api/state")).json()).items.find(i => i.id === "r1");
  const buys = () => env.DB.raw.prepare("SELECT COUNT(*) AS n FROM purchases").get().n;
  await post(env, ck, "/api/item", { ...base, done: false, addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { ...base, done: true, doneAt: new Date().toISOString() });       // 1× gekauft
  env.DB.raw.prepare("UPDATE items SET done_at = '2020-01-01T00:00:00.000Z'").run();
  await post(env, ck, "/api/item", { ...base, done: false, addedAt: new Date().toISOString() });      // wieder drauf
  assert.equal((await state()).buyCount, 1); assert.equal(buys(), 1);

  await post(env, ck, "/api/item", { ...base, done: true, doneAt: "2020-01-01T00:00:00.000Z", skip: true });   // doch nicht
  let it = await state();
  assert.equal(it.done, true, "steht wieder unter „Schon mal gekauft“");
  assert.equal(it.buyCount, 1, "Häufigkeit unverändert");
  assert.equal(buys(), 1, "kein neuer Kauf in der Statistik");

  await post(env, ck, "/api/item", { ...base, done: false, addedAt: new Date().toISOString() });      // Rückgängig
  it = await state();
  assert.equal(it.done, false); assert.equal(it.buyCount, 1, "Rückgängig zählt nicht ab"); assert.equal(buys(), 1);

  await post(env, ck, "/api/item", { ...base, done: true, doneAt: new Date().toISOString() });       // jetzt wirklich gekauft
  assert.equal((await state()).buyCount, 2); assert.equal(buys(), 2);
  assert.equal(checkItem({ id: "x", name: "a", store: "s", skip: "ja" }).skip, false, "nur echtes true zählt");
});

/* ---------- Kassenzettel ---------- */
import { parseReceipt, rawKey } from "../src/receipt.js";

// Beispiel-Bons im Aufbau der echten Bons (Inhalte erfunden)
const BON_PENNY = `*** PENNY-MARKT GMBH ***
*** 50354 Hürth ***
UID Nr.: DE202748117
EUR
BIO KOERN.FRISCH 2,90 B
2 Stk x 1,45
VEG.BACON WUERF. 1,99 B
App-Coupon -0,30 B
Birnen lose 0,55 B
0,184 kg x 2,99 EUR/kg
PENNY Tasche 0,25 A
--------------------------------------
SUMME EUR 5,39
Geg. VISA EUR 5,39
Steuer % Netto Steuer Brutto
A= 19,0% 0,21 0,04 0,25
Seriennnummer Kasse: REWE:18:c0:4d:18:64:bf:00
03.11.2026 15:48 Bon-Nr.:6558`;
const BON_LIDL = `Kölnstraße 110
50354 Hürth-Hermülheim
EUR
Apfel rot süß 1,54 A
0,672 kg x 2,29 EUR/kg
Lidl Plus Rabatt -0,15
Kiwi Gold 0,49 x 2 0,98 A
Coca Cola Zero 0,80 B
Pfand 0,25 M 0,25 B
zu zahlen 3,42
Kreditkarte 3,42
Summe 1,67 22,33 24,00
14.11.26 18:31
Mit Lidl Plus 0,15 EUR gespart`;
const BON_DM = `04.11.2026 16:06 D05G/2 333797/1 6048
SauBär Waschschaum 250ml 1,95 1
Einwegpfand 0,25 §1
2x 1,65 H-Bio Alpenmilch lakfr 3,30 2
Papiertragetasche 0,20 1
SUMME EUR 5,70
VISA EUR -5,70
Für diesen Einkauf erhältst Du von dm`;
const BON_ROSSMANN = `Du hast mit deinen Coupons 1,00€ gespart!
️️4068134245397️BABYDR.️PFLAUME-BA️️️€0,45️B
4001638590464️WELEDA️HYDRATING️B️️€9,95*A
Zwischensumme: €10,40
Deine Coupon-Ersparnis heute:
9823219992277 10% COUPONAKTION €1,00
Summe: €9,40
12.11.26, 14:03 / 3179 / 02 / 993 / 2188102822 / 1.1.5
Dirk Rossmann GmbH 3179`;

test("Kassenzettel lesen: Penny mit Menge, Gewicht, Coupon und Tasche", () => {
  const r = parseReceipt(BON_PENNY);
  assert.equal(r.shop, "Penny");                       // nicht „Rewe“, obwohl REWE in der Kassennummer steht
  assert.equal(r.at, "2026-11-03T15:48");
  assert.equal(r.total, 539); assert.equal(r.sum, 539);
  assert.deepEqual(r.lines.map(l => [l.raw, l.price, l.qty, l.unit, l.unitPrice, l.discount, l.kind]), [
    ["BIO KOERN.FRISCH", 290, 2, "stk", 145, 0, "item"],
    ["VEG.BACON WUERF.", 169, 1, "stk", 199, 30, "item"],
    ["Birnen lose", 55, 0.184, "kg", 299, 0, "item"],
    ["PENNY Tasche", 25, 1, "stk", 25, 0, "bag"]]);
});
test("Kassenzettel lesen: Lidl, dm und Rossmann", () => {
  const l = parseReceipt(BON_LIDL);
  assert.equal(l.shop, "Lidl"); assert.equal(l.at, "2026-11-14T18:31"); assert.equal(l.total, 342); assert.equal(l.sum, 342);
  assert.deepEqual(l.lines.map(x => [x.raw, x.price, x.qty, x.unitPrice, x.kind]),
    [["Apfel rot süß", 139, 0.672, 229, "item"], ["Kiwi Gold", 98, 2, 49, "item"], ["Coca Cola Zero", 80, 1, 80, "item"], ["Pfand 0,25 M", 25, 1, 25, "pfand"]]);
  const d = parseReceipt(BON_DM);
  assert.equal(d.shop, "dm"); assert.equal(d.at, "2026-11-04T16:06"); assert.equal(d.total, 570); assert.equal(d.sum, 570);
  assert.deepEqual(d.lines.map(x => [x.raw, x.qty, x.unitPrice, x.kind]),
    [["SauBär Waschschaum 250ml", 1, 195, "item"], ["Einwegpfand", 1, 25, "pfand"], ["H-Bio Alpenmilch lakfr", 2, 165, "item"], ["Papiertragetasche", 1, 20, "bag"]]);
  const ro = parseReceipt(BON_ROSSMANN);
  assert.equal(ro.shop, "Rossmann"); assert.equal(ro.at, "2026-11-12T14:03");
  assert.equal(ro.total, 940); assert.equal(ro.sub, 1040); assert.equal(ro.sum, 1040);
  assert.deepEqual(ro.lines.map(x => [x.ean, x.raw, x.price]), [["4068134245397", "BABYDR. PFLAUME-BA", 45], ["4001638590464", "WELEDA HYDRATING B", 995]]);
  assert.equal(rawKey("BIO  KOERN. FRISCH"), "bio koern.frisch");
});

test("Kassenzettel speichern: neue Artikel, Abhaken, gelernte Zuordnung, Preise, doppelt", async () => {
  const env = await setup(); const ck = await login(env);
  const d1 = { DB: env.DB, ASSETS: env.ASSETS };
  await post(d1, ck, "/api/stores", { list: [{ id: "supermarkt", name: "Supermarkt", labels: ["Penny", "Lidl"] }, { id: "drogerie", name: "Drogerie" }] });
  await post(d1, ck, "/api/item", { id: "birne", name: "Birnen", store: "supermarkt", done: false, addedAt: new Date().toISOString() });
  await post(d1, ck, "/api/item", { id: "skyr", name: "Skyr", store: "supermarkt", done: true, doneAt: new Date().toISOString(), buyCount: 3 });
  // Text → Zeilen
  let res = await post(d1, ck, "/api/receipt/parse", { text: BON_PENNY });
  const parsed = await res.json();
  assert.equal(parsed.shop, "Penny"); assert.equal(parsed.lines.length, 4);
  assert.ok(parsed.lines.every(l => l.alias === ""));
  // speichern: Birnen zugeordnet (steht auf der Liste → abhaken), Frischkäse neu, Bacon ohne Artikel, Tasche ignoriert
  const lines = parsed.lines.map(l => ({ ...l }));
  lines[0].newName = "Körniger Frischkäse"; lines[2].itemId = "birne"; lines[3].ignore = true;
  const body = { shop: "Penny", store: "supermarkt", at: parsed.at, total: parsed.total, source: "pdf", person: "Jonas", tick: true, lines };
  res = await post(d1, ck, "/api/receipt/save", body);
  const saved = await res.json();
  assert.equal(res.status, 200, JSON.stringify(saved)); assert.equal(saved.ticked, 1); assert.equal(saved.created, 1);
  // doppelt hochladen geht nicht
  assert.equal((await post(d1, ck, "/api/receipt/save", body)).status, 409);
  const st = await (await get(d1, ck, "/api/state")).json();
  const birne = st.items.find(i => i.id === "birne"), fk = st.items.find(i => i.name === "Körniger Frischkäse");
  assert.equal(birne.done, true); assert.equal(birne.buyCount, 1);
  assert.ok(fk && fk.done && fk.store === "supermarkt" && fk.shops[0] === "Penny");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM purchases WHERE item_id = 'birne'").get().n, 1);
  // beim nächsten Bon kennt die App die Zuordnungen schon – auch die ignorierte Tasche
  const again = await (await post(d1, ck, "/api/receipt/parse", { text: BON_PENNY })).json();
  assert.deepEqual(again.lines.map(l => l.alias), [fk.id, "", "birne", "-"]);
  // anderes Geschäft: Zuordnung wird übernommen, „ignorieren“ aber nicht
  const lidl = await (await post(d1, ck, "/api/receipt/parse", { text: "Lidl Plus\nBirnen lose 0,31 A\nVEG.BACON WUERF. 1,99 A\nzu zahlen 2,30\n14.11.26 18:31" })).json();
  assert.equal(lidl.shop, "Lidl"); assert.deepEqual(lidl.lines.map(l => l.alias), ["birne", ""]);
  // Preise je Artikel
  const pr = await (await get(d1, ck, "/api/prices?id=birne")).json();
  assert.deepEqual(pr.prices.map(p => [p.shop, p.price, p.unit, p.unitPrice]), [["Penny", 55, "kg", 299]]);
  // Liste, Einzelansicht, Löschen
  const list = await (await get(d1, ck, "/api/receipts")).json();
  assert.equal(list.receipts.length, 1); assert.equal(list.receipts[0].n, 3); assert.equal(list.receipts[0].total, 539);
  const one = await (await get(d1, ck, "/api/receipt?id=" + saved.id)).json();
  assert.deepEqual(one.lines.map(l => [l.kind, l.itemId]), [["item", fk.id], ["item", ""], ["item", "birne"], ["skip", ""]]);
  await post(d1, ck, "/api/receipt/delete", { id: saved.id });
  assert.equal((await (await get(d1, ck, "/api/receipts")).json()).receipts.length, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM receipt_lines").get().n, 0);
});

test("Kassenzettel: ungültige Angaben und Foto ohne Bilderkennung", async () => {
  const env = await setup(); const ck = await login(env);
  const ok = { shop: "Lidl", store: "supermarkt", at: "2026-11-14T18:31", total: 100, lines: [{ raw: "X", price: 100 }] };
  for (const bad of [{ ...ok, shop: "" }, { ...ok, at: "gestern" }, { ...ok, store: "../x" }, { ...ok, lines: [] }, { ...ok, total: -5 }])
    assert.equal((await post(env, ck, "/api/receipt/save", bad)).status, 400);
  assert.equal((await post(env, ck, "/api/receipt/save", ok)).status, 200);
  assert.equal((await post(env, ck, "/api/receipt/ocr", { images: ["data:image/jpeg;base64,AAAA"] })).status, 500);
  // mit (nachgebauter) Bilderkennung: Text wird wie ein PDF gelesen
  const calls = [];
  env.AI = { run: async (model, input) => { calls.push(model); return { response: BON_LIDL }; } };
  const r = await (await post(env, ck, "/api/receipt/ocr", { images: ["data:image/jpeg;base64,AAAA"] })).json();
  assert.equal(r.shop, "Lidl"); assert.equal(r.lines.length, 4); assert.equal(calls[0], "@cf/mistralai/mistral-small-3.1-24b-instruct");
  assert.equal((await post(env, ck, "/api/receipt/ocr", { images: ["javascript:alert(1)"] })).status, 400);
  assert.equal((await call(env, "/api/receipts")).status, 401);
});

/* ---------- Angebote, Preisalarm, Ladenvergleich ---------- */
import { queryFor, offerMatches, normalizeOffer, refreshOffers, alarmMessage } from "../src/offers.js";

const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const mgOffer = (id, adv, name, price, extra = {}) => ({ id, price, oldPrice: extra.old ?? null, referencePrice: extra.ref ?? null, unit: { shortName: extra.unit || "g" }, volume: extra.vol ?? 200,
  quantity: 1, description: extra.desc || "", product: { name }, brand: { name: extra.brand || "" }, advertisers: [{ name: adv }],
  validityDates: [{ from: (extra.from || inDays(-1)) + "T00:00:00Z", to: (extra.to || inDays(5)) + "T23:59:59Z" }] });

test("Angebote: Suchbegriff, Treffer-Prüfung, Umwandlung", () => {
  assert.equal(queryFor("Kleine Cola Dosen"), "Cola Dosen");
  assert.equal(queryFor("TK Erbsen"), "Erbsen");
  assert.equal(queryFor("Passierte Tomaten bio"), "Passierte Tomaten");
  assert.ok(offerMatches("Tomatenmark", "Oro di Parma Tomatenmark 2-fach konzentriert"));
  assert.ok(!offerMatches("Tomaten", "Tomatenmark"));                   // anderes Produkt
  assert.ok(offerMatches("Joghurt", "Weihenstephan Naturjoghurt"));
  assert.ok(offerMatches("Bananen", "Bio Banane"));
  assert.ok(offerMatches("Passierte Tomaten", "Tomaten passiert"));      // Wortreihenfolge egal
});
test("Angebote: Umwandlung der marktguru-Daten", () => {
  const o = normalizeOffer(mgOffer(7, "Netto Marken-Discount", "Tomatenmark", 0.49, { old: 0.79, ref: 2.45, brand: "Gut & Günstig", desc: "Bio, 200 g" }), ["Lidl", "Netto"]);
  assert.equal(o.shop, "Netto"); assert.equal(o.price, 49); assert.equal(o.oldPrice, 79); assert.equal(o.refPrice, 245); assert.equal(o.refUnit, "kg");
  assert.equal(o.amount, "200 g"); assert.equal(o.bio, 1); assert.equal(o.to, inDays(5));
  assert.equal(normalizeOffer(mgOffer(8, "Handelshof", "Tomatenmark", 0.3), ["Lidl"]).shop, "");
});

test("Angebote prüfen (Cron), Anzeige, Suchbegriff, Preisalarm, Ladenvergleich", async () => {
  const env = await setup(); const ck = await login(env);
  await post(env, ck, "/api/stores", { list: [{ id: "supermarkt", name: "Supermarkt", labels: ["Lidl", "Edeka", "Penny"] }, { id: "drogerie", name: "Drogerie", labels: ["dm"] }] });
  await post(env, ck, "/api/item", { id: "tm", name: "Tomatenmark", store: "supermarkt", done: false, addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "cola", name: "Kleine Cola Dosen", store: "supermarkt", done: false, addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "kaffee", name: "Kaffee", store: "supermarkt", done: true, doneAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "zp", name: "Zahnpasta", store: "drogerie", done: false, addedAt: new Date().toISOString() });
  // nachgebautes marktguru
  const calls = [];
  env.OFFERS_FETCH = async (url, opts) => {
    calls.push(String(url));
    if (String(url) === "https://www.marktguru.de/") return new Response('<script type="application/json">{"config":{"apiKey":"A","clientKey":"C"}}</script>');
    const u = new URL(url); const q = u.searchParams.get("q"), zip = u.searchParams.get("zipCode");
    let results = [];
    if (q === "Tomatenmark" && zip === "50354") results = [mgOffer(1, "Lidl", "Tomatenmark", 0.59, { old: 0.89 }), mgOffer(2, "Lidl", "Tomatenmark", 0.79, { desc: "Bio" }), mgOffer(3, "Penny", "Tomaten stückig", 0.5),
      mgOffer(4, "Edeka", "Tomatenmark", 0.2), mgOffer(5, "Handelshof", "Tomatenmark", 0.1)];
    if (q === "Tomatenmark" && zip === "50858") results = [mgOffer(6, "EDEKA", "Tomatenmark", 0.69, { from: inDays(2), to: inDays(8) })];
    if (q === "Kaffee") results = [mgOffer(9, "Penny", "Kaffee Crema", 3.99, { unit: "kg", vol: 1 })];
    return new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });
  };
  // ohne Geschäfte passiert nichts
  assert.deepEqual(await refreshOffers(env, null), []);
  assert.equal((await post(env, ck, "/api/offers/config", { zip: "123" })).status, 400);
  let res = await post(env, ck, "/api/offers/config", { zip: "50354", shops: ["Lidl", "Edeka", "Penny"], zipByShop: { Edeka: "50858", dm: "11111" } });
  assert.deepEqual((await res.json()).config, { zip: "50354", shops: ["Lidl", "Edeka", "Penny"], zipByShop: { Edeka: "50858" } });
  // Preisalarm für Kaffee (steht nicht auf der Liste): nur bis 4,00 €
  assert.equal((await post(env, ck, "/api/offers/watch", { itemId: "kaffee", alarm: true, alarmMax: 0 })).status, 400);
  await post(env, ck, "/api/offers/watch", { itemId: "kaffee", alarm: true, alarmMax: 400, person: "Jonas" });
  const sent = [];
  const out = await refreshOffers(env, msg => { sent.push(msg); });
  // geprüft: Tomatenmark, Cola (offen im Supermarkt) und Kaffee (Alarm) – nicht Zahnpasta (dm nicht in der Nähe)
  assert.deepEqual(out.map(o => o.id).sort(), ["cola", "kaffee", "tm"]);
  assert.ok(calls.some(c => c.includes("q=Cola+Dosen")));
  assert.ok(calls.some(c => c.includes("q=Tomatenmark") && c.includes("zipCode=50858")));
  const st = await (await get(env, ck, "/api/offers")).json();
  const tm = st.offers.filter(o => o.itemId === "tm").map(o => [o.id, o.shop, o.price, o.bio]).sort();
  // Lidl normal + Bio, Edeka nur aus 50858 (der Edeka-Treffer aus 50354 zählt nicht), kein „Tomaten stückig“, kein Handelshof
  assert.deepEqual(tm, [["1", "Lidl", 59, false], ["2", "Lidl", 79, true], ["6", "Edeka", 69, false]]);
  assert.equal(sent.length, 1); assert.equal(sent[0].title, "Preisalarm: Kaffee ab 3,99 €"); assert.match(sent[0].body, /^Penny: Kaffee Crema \(1 kg\) für 3,99 €, bis /);
  // zweiter Lauf: alles frisch geprüft → nichts zu tun, kein zweiter Alarm
  assert.deepEqual(await refreshOffers(env, msg => sent.push(msg)), []);
  assert.equal(sent.length, 1);
  // eigener Suchbegriff → wird sofort neu gesucht
  res = await post(env, ck, "/api/offers/watch", { itemId: "cola", query: "Coca Cola" });
  assert.deepEqual(await res.json(), { ok: true, query: "Coca Cola", auto: false });
  const w = await (await get(env, ck, "/api/offers")).json();
  assert.equal(w.watch.cola.query, "Coca Cola"); assert.equal(w.watch.cola.checkedAt, null);
  assert.equal(w.watch.tm.query, "");
  // „Jetzt prüfen“
  res = await post(env, ck, "/api/offers/check", { itemId: "cola" });
  assert.equal(res.status, 200); assert.ok(calls.some(c => c.includes("q=Coca+Cola")));
  // Preisverlauf enthält Angebote
  const pr = await (await get(env, ck, "/api/prices?id=tm")).json();
  assert.equal(pr.offers.length, 3);
  // Ladenvergleich: letzter Kassenzettel-Preis je Artikel und Geschäft
  const line = (raw, price, itemId) => ({ raw, price, unitPrice: price, qty: 1, itemId });
  await post(env, ck, "/api/receipt/save", { shop: "Penny", store: "supermarkt", at: "2026-10-01T10:00", total: 99, lines: [line("TOMATENMARK", 99, "tm")] });
  await post(env, ck, "/api/receipt/save", { shop: "Penny", store: "supermarkt", at: "2026-11-01T10:00", total: 89, lines: [line("TOMATENMARK", 89, "tm")] });
  const lat = await (await get(env, ck, "/api/prices/latest")).json();
  assert.deepEqual(lat.prices.map(p => [p.itemId, p.shop, p.price, p.at]), [["tm", "Penny", 89, "2026-11-01T10:00"]]);
  // Artikel löschen räumt Angebote mit auf
  await post(env, ck, "/api/item/delete", { id: "tm" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM offers WHERE item_id = 'tm'").get().n, 0);
});

test("Preisalarm-Nachricht", () => {
  const m = alarmMessage("Butter", [{ shop: "Lidl", title: "Kerrygold Butter", brand: "Kerrygold", price: 199, old_price: 299, amount: "250 g", valid_from: "2026-01-01", valid_to: "2099-01-03" },
    { shop: "Penny", title: "Butter", brand: "", price: 219, old_price: null, amount: "", valid_from: "2099-01-01", valid_to: "2099-01-07" }]);
  assert.equal(m.title, "Preisalarm: Butter ab 1,99 €");
  assert.match(m.body, /^Lidl: Kerrygold Butter \(250 g\) für 1,99 € statt 2,99 €, bis /);
  assert.match(m.body, /\nPenny: Butter für 2,19 €, ab /);
});
