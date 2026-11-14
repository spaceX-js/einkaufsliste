# Release v1.2.0 – Labels für einzelne Geschäfte

- Optionales Label pro Eintrag, z. B. „Edeka“ oder „dm“ – nur für Sachen, die ihr bewusst in einem bestimmten Geschäft kaufen wollt. Alle bestehenden Einträge bleiben ohne Label.
- Label setzen: im Bearbeiten-Dialog („Nur kaufen bei“) oder beim Eintippen mit `@`, z. B. `Brezel @Edeka`.
- Filter „Ich bin bei: Aldi / Edeka / …“: zeigt die Sachen mit diesem Label plus alles ohne Label; Sachen für andere Geschäfte werden ausgeblendet (mit Hinweis, wie viele).
- Labels je Laden in „Läden bearbeiten“ (Komma-getrennt). Start: Supermarkt – Aldi, Edeka, Lidl, Rewe; Drogerie – dm, Rossmann.
- Benachrichtigungen nennen das Label: „Brezel (Edeka)“.
- Datenbank: neue Spalte `items.shop` (`migrations/0003_labels.sql`, auf die Live-Datenbank bereits angewendet).
- Tests: 13 Server-Tests, Browser-Klicktest mit 33 Prüfungen.
