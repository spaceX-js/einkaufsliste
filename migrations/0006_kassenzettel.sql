-- Kassenzettel: Bon-Kopf, einzelne Zeilen mit Preisen und gelernte Zuordnungen (Bon-Text → Artikel)
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
