// Einkaufsliste – Cloudflare Worker
// Bindungen: DB (D1-Datenbank „einkaufsliste-db“) und ASSETS (Ordner public/).
// Das Passwort liegt nur als Hash in der Datenbank (Tabelle settings).

const COOKIE = "ek_session";
const ITER = 100000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STORE_RE = /^[A-Za-z0-9_-]{1,40}$/;

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) return text("Einrichtung unvollständig: Die Datenbank-Verbindung „DB“ fehlt.", 500);
      const url = new URL(request.url);
      const path = url.pathname;

      // Öffentlich: Icon und Manifest (für „Zum Home-Bildschirm“)
      if (path === "/icon.png" || path === "/icon-512.png" || path === "/manifest.webmanifest") return env.ASSETS.fetch(request);

      const settings = await getSettings(env);
      if (path === "/login" && request.method === "POST") return login(request, env, settings);
      if (path === "/logout") return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });

      const authed = await isAuthed(request, settings);

      if (path.startsWith("/api/")) {
        if (!authed) return json({ error: "Nicht angemeldet." }, 401);
        return await api(request, env, settings, url);
      }
      if (!authed) {
        if (path === "/" || path === "/index.html") return html(loginPage(url.searchParams.get("fehler")));
        return new Response(null, { status: 302, headers: { Location: "/" } });
      }
      // Angemeldet: Seite und Skript aus dem Ordner public/ (immer frisch, damit Updates sofort ankommen)
      const res = await env.ASSETS.fetch(path === "/index.html" ? new Request(new URL("/", url), request) : request);
      return withHeaders(res, { "Cache-Control": "no-cache", ...SEC });
    } catch (e) {
      return json({ error: "Serverfehler: " + (e && e.message ? e.message : e) }, 500);
    }
  }
};

/* ---------- API ---------- */
async function api(request, env, settings, url) {
  const path = url.pathname, method = request.method;

  if (path === "/api/state" && method === "GET") {
    const rev = Number(settings.rev || 0);
    if (url.searchParams.get("rev") === String(rev)) return json({ rev, same: true });
    const { results } = await env.DB.prepare("SELECT id, name, store, note, done, added_at, done_at FROM items").all();
    return json({
      rev,
      stores: parseStores(settings.stores),
      items: results.map(r => ({ id: r.id, name: r.name, store: r.store, note: r.note || "", done: !!r.done, addedAt: r.added_at || null, doneAt: r.done_at || null }))
    });
  }

  if (path === "/api/item" && method === "POST") {
    const it = checkItem(await readJson(request));
    if (!it) return json({ error: "Ungültiger Eintrag." }, 400);
    const now = new Date().toISOString();
    const [, bump] = await env.DB.batch([
      env.DB.prepare("INSERT INTO items (id, name, store, note, done, added_at, done_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, store = excluded.store, note = excluded.note, done = excluded.done, added_at = excluded.added_at, done_at = excluded.done_at, updated_at = excluded.updated_at")
        .bind(it.id, it.name, it.store, it.note, it.done ? 1 : 0, it.addedAt, it.doneAt, now),
      bumpRev(env)
    ]);
    return json({ ok: true, rev: revOf(bump) });
  }

  if (path === "/api/item/delete" && method === "POST") {
    const b = await readJson(request);
    if (!b || typeof b.id !== "string" || !ID_RE.test(b.id)) return json({ error: "Ungültige Anfrage." }, 400);
    const [, bump] = await env.DB.batch([env.DB.prepare("DELETE FROM items WHERE id = ?").bind(b.id), bumpRev(env)]);
    return json({ ok: true, rev: revOf(bump) });
  }

  if (path === "/api/stores" && method === "POST") {
    const b = await readJson(request);
    const list = checkStores(b && b.list);
    if (!list) return json({ error: "Ungültige Läden." }, 400);
    const [, bump] = await env.DB.batch([setSetting(env, "stores", JSON.stringify(list)), bumpRev(env)]);
    return json({ ok: true, rev: revOf(bump) });
  }

  if (path === "/api/password" && method === "POST") {
    const b = await readJson(request);
    if (!b || typeof b.new !== "string" || b.new.length < 8) return json({ error: "Das neue Passwort braucht mindestens 8 Zeichen." }, 400);
    if (!(await checkPassword(String(b.old || ""), settings))) { await sleep(1000); return json({ error: "Das aktuelle Passwort stimmt nicht." }, 400); }
    const salt = randomHex(16), hash = await pbkdf2(b.new, salt), secret = randomHex(32);
    await env.DB.batch([setSetting(env, "pw_salt", salt), setSetting(env, "pw_hash", hash), setSetting(env, "session_secret", secret)]);
    return json({ ok: true }, 200, { "Set-Cookie": cookie(await sessionToken(secret)) });
  }

  return json({ error: "Nicht gefunden." }, 404);
}

/* ---------- Prüfen ---------- */
function isoOrNull(v) { return (typeof v === "string" && v.length <= 40 && !isNaN(Date.parse(v))) ? new Date(v).toISOString() : null; }
export function checkItem(b) {
  if (!b || typeof b !== "object" || typeof b.id !== "string" || !ID_RE.test(b.id)) return null;
  const name = String(b.name == null ? "" : b.name).trim().slice(0, 120);
  if (!name || typeof b.store !== "string" || !STORE_RE.test(b.store)) return null;
  return { id: b.id, name, store: b.store, note: String(b.note || "").trim().slice(0, 300), done: !!b.done, addedAt: isoOrNull(b.addedAt), doneAt: isoOrNull(b.doneAt) };
}
export function checkStores(list) {
  if (!Array.isArray(list) || !list.length || list.length > 30) return null;
  const out = [], seen = new Set();
  for (const s of list) {
    if (!s || typeof s.id !== "string" || !STORE_RE.test(s.id) || seen.has(s.id)) return null;
    const name = String(s.name || "").trim().slice(0, 40);
    if (!name) return null;
    seen.add(s.id); out.push({ id: s.id, name });
  }
  return out;
}
export function parseStores(v) { try { return checkStores(JSON.parse(v || "[]")) || []; } catch (e) { return []; } }

/* ---------- Anmeldung ---------- */
async function login(request, env, settings) {
  const form = await request.formData();
  const pw = String(form.get("passwort") || "");
  const ip = request.headers.get("CF-Connecting-IP") || "unbekannt";
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts > ?").bind(ip, since).first();
  if (row && row.n >= 10) return redirect("/?fehler=gesperrt");
  if (!settings.pw_hash || !(await checkPassword(pw, settings))) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO login_attempts (ip, ts) VALUES (?, ?)").bind(ip, new Date().toISOString()),
      env.DB.prepare("DELETE FROM login_attempts WHERE ts < ?").bind(new Date(Date.now() - 86400000).toISOString())
    ]);
    await sleep(800);
    return redirect("/?fehler=falsch");
  }
  return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": cookie(await sessionToken(settings.session_secret)) } });
}
function cookie(token) { return `${COOKIE}=${token}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`; }
async function isAuthed(request, settings) {
  if (!settings.session_secret) return false;
  const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([a-f0-9]+)"));
  return !!m && safeEqual(m[1], await sessionToken(settings.session_secret));
}
async function checkPassword(pw, s) {
  if (!s.pw_salt || !s.pw_hash) return false;
  return safeEqual(await pbkdf2(pw, s.pw_salt), s.pw_hash);
}
export async function pbkdf2(pw, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: ITER }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
async function sessionToken(secretHex) {
  const key = await crypto.subtle.importKey("raw", hexToBytes(secretHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("einkaufsliste-session-v1"));
  return bytesToHex(new Uint8Array(sig));
}

/* ---------- Datenbank ---------- */
async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const s = {}; for (const r of results) s[r.key] = r.value; return s;
}
function setSetting(env, k, v) { return env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v); }
function bumpRev(env) { return env.DB.prepare("INSERT INTO settings (key, value) VALUES ('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value"); }
function revOf(res) { const r = res && res.results && res.results[0]; return r ? Number(r.value) : null; }

/* ---------- Hilfsfunktionen ---------- */
const SEC = { "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };
function withHeaders(res, h) { const r = new Response(res.body, res); for (const [k, v] of Object.entries(h)) r.headers.set(k, v); return r; }
function html(body) { return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SEC } }); }
function json(o, status = 200, extra = {}) { return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SEC, ...extra } }); }
function text(t, status = 200) { return new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
function redirect(to) { return new Response(null, { status: 303, headers: { Location: to } }); }
async function readJson(req) { try { return await req.json(); } catch (e) { return null; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomHex(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return bytesToHex(b); }
function bytesToHex(b) { return Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
function safeEqual(a, b) { if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

function loginPage(fehler) {
  const msg = fehler === "falsch" ? "Das Passwort stimmt nicht." : fehler === "gesperrt" ? "Zu viele Versuche. Bitte in 15 Minuten nochmal probieren." : "";
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Einkauf"><meta name="robots" content="noindex, nofollow">
<link rel="apple-touch-icon" href="/icon.png"><link rel="icon" href="/icon.png"><link rel="manifest" href="/manifest.webmanifest">
<title>Einkaufsliste – Anmelden</title>
<style>
:root{--bg:#f2f1ee;--card:#fff;--ink:#1d1d1b;--mute:#6f6c66;--line:#e6e3dd;--acc:#2f6f5e;--acc-ink:#fff;--bad:#b3261e}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#f1efe9;--mute:#a19d95;--line:#33322f;--acc:#7cc4ad;--acc-ink:#10201b;--bad:#f28b82}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:400px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 60px) 24px 40px;text-align:center}
img{width:76px;height:76px;border-radius:18px}h1{font-size:26px;margin:16px 0 6px}p{color:var(--mute);margin:0 0 24px;font-size:15px}
input{width:100%;font-size:17px;padding:13px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);margin-bottom:12px;-webkit-appearance:none}
input:focus{outline:2px solid var(--acc);outline-offset:-1px}
button{width:100%;min-height:50px;border:0;border-radius:13px;background:var(--acc);color:var(--acc-ink);font:600 17px -apple-system,sans-serif}
.err{color:var(--bad);font-size:15px;margin:0 0 12px}
</style></head><body><main>
<img src="/icon.png" alt=""><h1>Einkaufsliste</h1><p>Bitte gib euer Passwort ein.</p>
${msg ? `<div class="err">${msg}</div>` : ""}
<form method="post" action="/login"><input type="password" name="passwort" autocomplete="current-password" placeholder="Passwort" required autofocus>
<button type="submit">Anmelden</button></form></main></body></html>`;
}
