# Release v1.0.0 – Eigenständige Einkaufsliste

- Umzug aus dem Claude-Artefakt auf einen eigenen Cloudflare Worker mit D1-Datenbank (`einkaufsliste-db`) – kein Claude-Konto mehr nötig, keine Kosten.
- Anmeldung mit gemeinsamem Passwort (anfangs dasselbe wie beim Haushaltsplan), Sitzung bleibt ca. 1 Jahr gespeichert.
- Alle 223 Einträge aus der Apple-Notiz bzw. dem Artefakt übernommen (22 offen, Rest unter „Schon mal gekauft“), 5 Läden.
- Abgleich zwischen zwei Handys über einen Änderungszähler (Abfrage alle 4 s, nur solange die Seite sichtbar ist).
- Einstellungen: Läden bearbeiten, Passwort ändern, Abmelden.
- Tests: 6 Server-Tests (`npm test`) und ein Klicktest im Browser (`test/e2e.mjs`).
