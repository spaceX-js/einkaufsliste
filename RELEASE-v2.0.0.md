# Einkaufsliste v2.0.0 – Kassenzettel, Angebote, Preise

Neu:
- **Kassenzettel**: PDF, Foto/Screenshot oder aus der Zwischenablage (Bild oder Text). Zeilen werden Artikeln zugeordnet (Vorschläge, gelernte Zuordnung je Geschäft), gekaufte Sachen auf Wunsch abgehakt. Läden ohne Labels (z. B. IKEA) und eigene Geschäfte wählbar.
- **Angebote** (Etikett-Symbol → „Preise“): nur für markierte Artikel („Angebote suchen“, Suchbegriff vorher prüfbar), sortiert nach Grundpreis, „schon gekauft“ für die bekannte Sorte, Knopf „Neue Angebote suchen“.
- **Preiswecker**: Nachricht bei Angebot, optional mit Höchstpreis.
- **Ladenvergleich** mit Schätzung und günstigstem Mix, **Preisverlauf** je Artikel, „Zuletzt bezahlt“ im Bearbeiten-Dialog.
- **Statistik** nur noch aus Kassenzetteln: Ausgaben (Zeitraum, 12 Wochen, nach Geschäft) und „Laut Kassenzettel gekauft“.
- **Kennzeichen „Dringend“ / „Vorrat“** – beim Eintragen neben dem Eingabefeld oder über den Stift; fällt beim Kaufen/Abnehmen weg.
- **Autovervollständigung** beim Eintippen aus allen angelegten Artikeln.
- Stift statt „⋯“ am Eintrag.

Datenbank: Migrationen 0006–0009 (receipts, receipt_lines, receipt_alias, offers, offer_watch, items.prio).
Workers AI (Binding `AI`) für Fotos, im kostenlosen Kontingent.
Test-App: Worker `einkaufsliste-test` (`--env test`, eigene Datenbank) für künftige Feature-Branches.
