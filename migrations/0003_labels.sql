-- v1.2.0: optionale Labels für einzelne Geschäfte (z. B. Aldi, Edeka, dm)
-- Die Label-Auswahl je Laden steht in settings.stores ("labels": [...]); bestehende Einträge bleiben ohne Label.
ALTER TABLE items ADD COLUMN shop TEXT NOT NULL DEFAULT '';
