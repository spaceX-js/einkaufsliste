-- Angebote aus Prospekten je Artikel (bleiben für den Preisverlauf ein Jahr stehen)
CREATE TABLE IF NOT EXISTS offers (
  item_id    TEXT NOT NULL,
  offer_id   TEXT NOT NULL,
  shop       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  brand      TEXT NOT NULL DEFAULT '',
  price      INTEGER NOT NULL,           -- Cent
  old_price  INTEGER,
  ref_price  INTEGER,                    -- Cent je kg/l
  ref_unit   TEXT NOT NULL DEFAULT '',
  amount     TEXT NOT NULL DEFAULT '',   -- z. B. „500 g“
  bio        INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL DEFAULT '',
  valid_to   TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (item_id, offer_id)
);
CREATE INDEX IF NOT EXISTS offers_to ON offers(valid_to);
-- Je Artikel: eigener Suchbegriff, wann zuletzt geprüft, Preisalarm
CREATE TABLE IF NOT EXISTS offer_watch (
  item_id      TEXT PRIMARY KEY,
  query        TEXT NOT NULL DEFAULT '',  -- leer = aus dem Namen
  checked_at   TEXT,
  alarm        INTEGER NOT NULL DEFAULT 0,
  alarm_max    INTEGER,                   -- Cent; leer = jedes Angebot
  alarm_person TEXT NOT NULL DEFAULT '',
  alarm_sent   TEXT NOT NULL DEFAULT ''   -- schon gemeldete Angebote
);
