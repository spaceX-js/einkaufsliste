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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_store ON items(store);

-- pw_salt, pw_hash, session_secret, rev (Änderungszähler), stores (JSON-Liste der Läden)
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip, ts);
