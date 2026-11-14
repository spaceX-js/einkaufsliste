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
