# Einkaufsliste

Gemeinsame Einkaufsliste für zu Hause – getrennt nach Läden (Supermarkt, Drogerie, Fressnapf, Baumarkt, IKEA …).
Läuft kostenlos auf Cloudflare Workers mit einer D1-Datenbank. Kein Claude-Konto nötig, Anmeldung mit einem gemeinsamen Passwort.

## Funktionen

- Läden oben als Reiter, mit Anzahl der offenen Sachen
- Eintippen + Enter fügt hinzu; ab 2 Buchstaben Vorschläge aus „Schon mal gekauft“
- Antippen hakt ab (mit „Rückgängig“); Abgehaktes erscheint unter „Schon mal gekauft“ und lässt sich mit einem Tipp wieder auf die Liste setzen
- „⋯“ bzw. gedrückt halten: Name, Notiz (Menge, Marke) und Laden ändern oder löschen
- **Sortierung** (merkt sich jedes Handy): offene Sachen nach *Warengruppe* (Weg durch den Laden) oder *Neueste zuerst*; „Schon mal gekauft“ nach *Häufigkeit* oder *Warengruppe*
- **Warengruppen** werden über Stichwörter erkannt (`public/groups.js`); falsche Zuordnung im Bearbeiten-Dialog ändern
- **Häufigkeit**: jedes Abhaken zählt +1; wird innerhalb von 10 Minuten zurückgenommen, wieder −1
- **Benachrichtigungen**: Trägt Jonas etwas ein, bekommt Clara eine Nachricht (und umgekehrt). Mehrere Einträge kurz hintereinander werden zu einer Nachricht zusammengefasst (12 s Wartezeit). Auf dem iPhone nur, wenn die Liste auf dem Home-Bildschirm liegt (ab iOS 16.4)
- „Dieses Handy gehört“: Jonas oder Clara; Einträge des anderen zeigen „von …“
- **Labels für einzelne Geschäfte** (optional): z. B. „Edeka“ an „Brezel“, wenn es die nur dort geben soll. Setzen über „⋯“ oder beim Eintippen mit `@`: `Brezel @Edeka`. Mit „Ich bin bei: Aldi“ zeigt die Liste nur Sachen für Aldi und alles ohne Label. Welche Labels es gibt, steht pro Laden unter Einstellungen → Läden bearbeiten (gespeichert in `settings.stores`)
- Läden umbenennen, sortieren, neu anlegen; Passwort ändern; Abmelden
- Zweites Handy sieht Änderungen nach spätestens ~4 Sekunden (die Seite fragt alle 4 s, ob sich etwas geändert hat)
- Funktioniert als Home-Bildschirm-App (Icon + Manifest); zeigt ohne Netz den zuletzt geladenen Stand

## Aufbau

| Datei | Zweck |
|---|---|
| `src/index.js` | Worker: Anmeldung, API (`/api/state`, `/api/item`, `/api/item/delete`, `/api/stores`, `/api/password`) |
| `public/index.html`, `public/app.js` | Oberfläche (nur nach Anmeldung erreichbar) |
| `public/groups.js` | Warengruppen und Stichwortregeln |
| `public/sw.js` | Service Worker: zeigt Benachrichtigungen (öffentlich, enthält keine Daten) |
| `src/push.js` | Web Push ohne Fremddienst: VAPID-Signatur und Verschlüsselung (RFC 8291/8292) |
| `migrations/` | Änderungen für eine bestehende Datenbank |
| `public/icon*.png`, `public/manifest.webmanifest` | Icon und App-Manifest (öffentlich) |
| `d1-schema.sql` | Tabellen `items`, `settings`, `login_attempts`, `push_subs` (für eine neue Datenbank) |
| `wrangler.jsonc` | Cloudflare-Einstellungen (Datenbank `einkaufsliste-db`) |
| `test/worker.test.mjs` | Tests gegen eine lokale SQLite-Datenbank (`npm test`) |
| `test/e2e.mjs` | Klicktest im Browser (lokal, braucht Playwright) |

Das Passwort liegt nur als PBKDF2-Hash in `settings` (`pw_salt`, `pw_hash`). Nach 10 Fehlversuchen in 15 Minuten wird eine IP kurz gesperrt.
`settings.rev` ist ein Änderungszähler: Die Seite lädt die Liste nur neu, wenn er sich geändert hat.

Benachrichtigungen laufen über die Push-Dienste von Apple/Google, die der Browser selbst mitbringt – kostenlos, ohne Konto. Der Schlüssel dafür (VAPID) entsteht beim ersten Einschalten automatisch und liegt in `settings`.

## Kosten

Alles bleibt im kostenlosen Cloudflare-Tarif (Workers Free: 100.000 Aufrufe/Tag, D1 Free: 5 Mio. gelesene Zeilen/Tag).
Ein offenes Handy erzeugt ca. 900 Aufrufe pro Stunde; im Hintergrund fragt die Seite nicht nach.

## Veröffentlichen (Deploy)

Cloudflare baut und veröffentlicht automatisch bei jedem Push auf `main` (Workers Builds, mit GitHub verbunden).
Manuell: `npm install && npx wrangler deploy`.

## Datenbank neu aufsetzen

```sh
npx wrangler d1 create einkaufsliste-db            # ID in wrangler.jsonc eintragen
npx wrangler d1 execute einkaufsliste-db --remote --file=d1-schema.sql
```

Danach in der Tabelle `settings` `pw_salt`, `pw_hash` (PBKDF2-SHA256, 100.000 Runden, hex) und `session_secret` (64 Hex-Zeichen) setzen.
