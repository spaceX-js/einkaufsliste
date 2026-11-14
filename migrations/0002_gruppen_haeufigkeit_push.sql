-- v1.1.0: Warengruppe, Häufigkeit, „eingetragen von“ und Benachrichtigungen
-- Für eine bestehende Datenbank (v1.0.0). Neue Datenbanken bekommen alles über d1-schema.sql.
ALTER TABLE items ADD COLUMN cat TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN buy_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN added_by TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  person     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('people', '["Jonas","Clara"]');
