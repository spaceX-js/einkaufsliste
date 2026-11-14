# Release v1.1.0 – Sortierung, Häufigkeit, Benachrichtigungen

- Offene Sachen sortierbar nach **Warengruppe** (14 Gruppen in Ladenreihenfolge, z. B. Obst & Gemüse → Kühlregal → Tiefkühl …) oder **Neueste zuerst**.
- „Schon mal gekauft“ sortierbar nach **Häufigkeit** (mit „3×“-Anzeige) oder **Warengruppe**.
- Warengruppe wird automatisch erkannt und lässt sich pro Eintrag ändern.
- Startwerte für die Häufigkeit aus der alten Apple-Notiz übernommen (wie oft dort abgehakt).
- **Benachrichtigungen** an den anderen, wenn etwas eingetragen wird – zusammengefasst, nur an den anderen, per Web Push (kostenlos).
- „Dieses Handy gehört …“ und „von Clara“/„von Jonas“ an Einträgen.
- Datenbank: neue Spalten `cat`, `buy_count`, `added_by`, neue Tabelle `push_subs` (`migrations/0002_…sql`, auf die Live-Datenbank bereits angewendet).
- Tests: 11 Server-Tests (u. a. Entschlüsselung einer echten Push-Nachricht, VAPID-Signatur), Browser-Klicktest mit 26 Prüfungen.
