# Release v1.3.0 – Mehrere Labels, strenge Filter

- Ein Eintrag kann jetzt mehrere Labels haben (z. B. „Edeka“ und „Aldi“). Im Dialog „⋯“ einfach mehrere antippen, „Keins“ entfernt alle; beim Eintippen: `Brezel @Edeka @Aldi`.
- Die Label-Knöpfe oben sind echte Filter: Es erscheinen **nur** Sachen mit dem gewählten Label (vorher auch alles ohne Label). Mehrere Filter gleichzeitig zeigen alles, was eins davon hat; „Alle“ setzt zurück.
- Die vorhandenen einzelnen Labels bleiben unverändert erhalten (Spalte `shop`, mehrere als `Edeka|Aldi` – keine Datenbank-Änderung nötig).
- Tests: 13 Server-Tests, Browser-Klicktest mit 35 Prüfungen.
