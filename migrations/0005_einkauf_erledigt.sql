-- v1.5.0: „… war einkaufen“-Nachricht
ALTER TABLE purchases ADD COLUMN announced INTEGER NOT NULL DEFAULT 0;
-- bisherige Käufe nicht nachträglich melden
UPDATE purchases SET announced = 1;
CREATE INDEX IF NOT EXISTS purchases_announced ON purchases(announced, person);
