-- Einkaufsliste – Datenbank-Schema (Cloudflare D1)
-- Einmalig ausführen: npx wrangler d1 execute einkaufsliste-db --remote --file=d1-schema.sql

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  store      TEXT NOT NULL,          -- Laden-ID, z. B. "supermarkt"
  note       TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0,   -- 1 = abgehakt (steht dann unter „Schon mal gekauft“)
  added_at   TEXT,
  done_at    TEXT,
  updated_at TEXT NOT NULL,
  cat        TEXT NOT NULL DEFAULT '',   -- Warengruppe, leer = automatisch nach Stichwörtern
  buy_count  INTEGER NOT NULL DEFAULT 0, -- wie oft schon gekauft (abgehakt)
  added_by   TEXT NOT NULL DEFAULT '',   -- wer es zuletzt auf die Liste gesetzt hat
  shop       TEXT NOT NULL DEFAULT ''    -- optional: nur in diesem Geschäft kaufen (Label, z. B. „Edeka“)
);
CREATE INDEX IF NOT EXISTS items_store ON items(store);

-- pw_salt, pw_hash, session_secret, rev (Änderungszähler), stores (JSON-Liste der Läden),
-- people (JSON-Liste der Namen), vapid_public / vapid_private (Schlüssel für Benachrichtigungen, entstehen automatisch)
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip, ts);

-- Geräte, die Benachrichtigungen bekommen (Web Push)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  person     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
