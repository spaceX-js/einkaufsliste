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

-- Statistik: ein Eintrag pro Kauf (abgehakt), mit Datum
CREATE TABLE IF NOT EXISTS purchases (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  store   TEXT NOT NULL,
  cat     TEXT NOT NULL DEFAULT '',
  shop    TEXT NOT NULL DEFAULT '',
  person  TEXT NOT NULL DEFAULT '',
  at      TEXT NOT NULL,
  announced INTEGER NOT NULL DEFAULT 0   -- 1 = in einer „… war einkaufen“-Nachricht enthalten
);
CREATE INDEX IF NOT EXISTS purchases_at ON purchases(at);
CREATE INDEX IF NOT EXISTS purchases_item ON purchases(item_id, at);

CREATE TABLE IF NOT EXISTS receipts (
  id         TEXT PRIMARY KEY,
  shop       TEXT NOT NULL,              -- Geschäft, z. B. „Lidl“ (wie die Labels)
  store      TEXT NOT NULL DEFAULT '',   -- Laden-Bereich der App, z. B. „supermarkt“
  at         TEXT NOT NULL,              -- Einkaufszeit (Ortszeit, z. B. 2026-11-14T18:31)
  total      INTEGER NOT NULL,           -- bezahlte Summe in Cent
  source     TEXT NOT NULL DEFAULT '',   -- pdf oder foto
  person     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_at ON receipts(at);
CREATE TABLE IF NOT EXISTS receipt_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL,
  pos        INTEGER NOT NULL,
  raw        TEXT NOT NULL,              -- Text wie auf dem Bon
  ean        TEXT NOT NULL DEFAULT '',
  qty        REAL NOT NULL DEFAULT 1,
  unit       TEXT NOT NULL DEFAULT 'stk',-- stk oder kg
  unit_price INTEGER NOT NULL DEFAULT 0, -- Cent pro Stück bzw. pro kg
  price      INTEGER NOT NULL,           -- Cent für die Zeile nach Rabatt
  discount   INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL DEFAULT 'item', -- item, pfand, bag, skip
  item_id    TEXT                         -- zugeordneter Artikel der Liste (oder leer)
);
CREATE INDEX IF NOT EXISTS receipt_lines_r ON receipt_lines(receipt_id, pos);
CREATE INDEX IF NOT EXISTS receipt_lines_item ON receipt_lines(item_id);
CREATE TABLE IF NOT EXISTS receipt_alias (
  shop    TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  item_id TEXT NOT NULL,                  -- „-“ = beim nächsten Mal ignorieren
  PRIMARY KEY (shop, raw_key)
);
