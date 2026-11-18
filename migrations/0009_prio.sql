-- Kennzeichen „dringend“ oder „Vorrat“ für Sachen auf der Liste; fällt beim Kaufen/Abnehmen wieder weg
ALTER TABLE items ADD COLUMN prio TEXT NOT NULL DEFAULT '';
