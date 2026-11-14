-- v1.4.0: Statistik – jeder Kauf mit Datum
CREATE TABLE IF NOT EXISTS purchases (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  store   TEXT NOT NULL,
  cat     TEXT NOT NULL DEFAULT '',
  shop    TEXT NOT NULL DEFAULT '',
  person  TEXT NOT NULL DEFAULT '',
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS purchases_at ON purchases(at);
CREATE INDEX IF NOT EXISTS purchases_item ON purchases(item_id, at);
-- Käufe von vor dem Start der Statistik haben kein Datum. Nur die seit Start der App (14.11.2026, 10:14 Uhr)
-- abgehakten Sachen werden mit ihrem echten Zeitpunkt nachgetragen (siehe Release-Notiz v1.4.0).
