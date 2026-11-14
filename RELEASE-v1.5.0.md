# Release v1.5.0 – „… war einkaufen“-Nachricht

- Wenn einer von euch Sachen abhakt und danach 5 Minuten lang nichts mehr, bekommt der andere eine Benachrichtigung, z. B.:
  **„Jonas war einkaufen – 8 Sachen abgehakt“**
  „Supermarkt: Bananen, Skyr, Eier … · Drogerie: Zahnpasta
  Noch offen: Supermarkt 2“
- Mehrere Läden auf einer Tour landen in einer Nachricht; mehr als 5 Artikel pro Laden werden als „und … weitere“ zusammengefasst.
- Innerhalb von 10 Minuten zurückgenommenes Abhaken zählt nicht. Abhaken ohne „Dieses Handy gehört“ wird nicht gemeldet.
- Technik: Cloudflare Cron-Trigger alle 5 Minuten (kostenlos), neue Spalte `purchases.announced` (Migration 0005; die bisherigen 25 Käufe sind als „gemeldet“ markiert und werden nicht nachträglich verschickt). Die App merkt sich ihre Adresse (`settings.origin`) als Absender für die Nachrichten.
- Tests: 17 Server-Tests (u. a. Entschlüsselung der Nachricht, 5-Minuten-Ruhe, nur einmal, nur an den anderen), Browser-Klicktest mit 52 Prüfungen.
