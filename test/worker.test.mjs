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

/* ---------- v1.2: Labels für einzelne Geschäfte ---------- */
test("Labels: am Eintrag optional, je Laden einstellbar, in der Nachricht sichtbar", async () => {
  const env = await setup(); const ck = await login(env);
  await post(env, ck, "/api/stores", { list: [{ id: "supermarkt", name: "Supermarkt", labels: ["Aldi", " Edeka ", "aldi", ""] }, { id: "drogerie", name: "Drogerie" }] });
  let st = await (await get(env, ck, "/api/state")).json();
  assert.deepEqual(st.stores[0].labels, ["Aldi", "Edeka"], "doppelte/leere Labels entfernt");
  assert.equal(st.stores[1].labels, undefined, "Laden ohne Labels bleibt ohne");

  await post(env, ck, "/api/item", { id: "l1", name: "Brezel", store: "supermarkt", shop: "Edeka", addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "l2", name: "Milch", store: "supermarkt", addedAt: new Date().toISOString() });
  await post(env, ck, "/api/item", { id: "l3", name: "X", store: "supermarkt", shop: "<b>Lidl</b>\n" });
  st = await (await get(env, ck, "/api/state")).json();
  const by = id => st.items.find(i => i.id === id);
  assert.equal(by("l1").shop, "Edeka");
  assert.equal(by("l2").shop, "", "ohne Label bleibt leer");
  assert.equal(by("l3").shop, "bLidl/b", "Sonderzeichen entfernt");

  // Label wieder entfernen
  await post(env, ck, "/api/item", { id: "l1", name: "Brezel", store: "supermarkt", shop: "" });
  st = await (await get(env, ck, "/api/state")).json();
  assert.equal(st.items.find(i => i.id === "l1").shop, "");
});

test("Labels: Nachricht nennt das Geschäft", async () => {
  const { buildMessage } = await import("../src/index.js");
  const m = buildMessage("Clara", [{ name: "Brezel", store: "supermarkt", shop: "Edeka" }, { name: "Milch", store: "supermarkt", shop: "" }], [{ id: "supermarkt", name: "Supermarkt" }]);
  assert.equal(m.body, "Supermarkt: Brezel (Edeka), Milch");
});
