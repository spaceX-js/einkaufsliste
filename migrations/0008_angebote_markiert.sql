-- Angebote nur noch für markierte Artikel suchen („Angebote suchen“ im Artikel)
ALTER TABLE offer_watch ADD COLUMN search INTEGER NOT NULL DEFAULT 0;
UPDATE offer_watch SET search = 1 WHERE alarm = 1;
