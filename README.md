# Einkaufsliste

Gemeinsame Einkaufsliste für zu Hause – getrennt nach Läden (Supermarkt, Drogerie, Fressnapf, Baumarkt, IKEA …).
Läuft kostenlos auf Cloudflare Workers mit einer D1-Datenbank. Kein Claude-Konto nötig, Anmeldung mit einem gemeinsamen Passwort.

## Funktionen

- Läden oben als Reiter, mit Anzahl der offenen Sachen
- **Kennzeichen „Dringend“ und „Vorrat“** (beim Eintragen über die kleinen Knöpfe „!“ und Kiste zwischen Eingabefeld und + – gilt für den nächsten Eintrag, auch über Autovervollständigung oder „Schon mal gekauft“ – oder später über den Stift am Eintrag): Dringendes steht oben in einem eigenen Block, „Vorrat“ als blaues Kennzeichen. Beides fällt automatisch weg, sobald der Artikel abgehakt, von der Liste genommen oder gelöscht wird (Spalte `prio`, Migration 0009)
- Eintippen + Enter fügt hinzu; Autovervollständigung ab dem ersten Buchstaben aus allem, was schon angelegt ist (alle Läden, Wortanfänge zuerst, getippter Teil fett; Antippen trägt den Artikel in seinem eigenen Laden ein, getippte @Labels bleiben erhalten, Offenes zeigt „steht schon drauf“)
- Antippen hakt ab (mit „Rückgängig“); Abgehaktes erscheint unter „Schon mal gekauft“ und lässt sich mit einem Tipp wieder auf die Liste setzen
- **×** am Eintrag: „doch nicht kaufen“ – nimmt ihn von der Liste, zählt aber nicht als Kauf (keine Häufigkeit, keine Nachricht); er steht wieder unter „Schon mal gekauft“. Technisch: `/api/item` mit `skip: true`
- „⋯“ bzw. gedrückt halten: Name, Notiz (Menge, Marke) und Laden ändern, von der Liste nehmen oder ganz löschen (auch aus „Schon mal gekauft“)
- **Sortierung** (merkt sich jedes Handy): offene Sachen nach *Warengruppe* (Weg durch den Laden) oder *Neueste zuerst* (gilt für alle Läden); „Schon mal gekauft“ nach *Häufigkeit* oder *Warengruppe* (merkt sich jeder Laden einzeln)
- **Warengruppen** werden über Stichwörter erkannt (`public/groups.js`); falsche Zuordnung im Bearbeiten-Dialog ändern
- **Häufigkeit**: jedes Abhaken zählt +1; wird innerhalb von 10 Minuten zurückgenommen, wieder −1
- **Benachrichtigungen**: Trägt Jonas etwas ein, bekommt Clara eine Nachricht (und umgekehrt). Mehrere Einträge kurz hintereinander werden zu einer Nachricht zusammengefasst (12 s Wartezeit). Auf dem iPhone nur, wenn die Liste auf dem Home-Bildschirm liegt (ab iOS 16.4)
- **„… war einkaufen“-Nachricht**: Hat jemand Sachen abgehakt und 5 Minuten lang nichts mehr, bekommt der andere eine Zusammenfassung („Jonas war einkaufen – 8 Sachen abgehakt“, je Laden die Artikel und was dort noch offen ist). Läuft über einen Cloudflare Cron-Trigger alle 5 Minuten (`scheduled` in `src/index.js`, `triggers.crons` in `wrangler.jsonc`); gemeldete Käufe werden in `purchases.announced` markiert
- „Dieses Handy gehört“: Jonas oder Clara; Einträge des anderen zeigen „von …“
- **Labels für einzelne Geschäfte** (optional, mehrere pro Eintrag): z. B. „Edeka“ und „Aldi“ an „Brezel“. Setzen über „⋯“ oder beim Eintippen mit `@`: `Brezel @Edeka @Aldi`. Die Filter oben („Filter: Alle · Aldi · Edeka …“) zeigen nur Sachen mit einem der gewählten Labels; mehrere Filter gleichzeitig = „oder“. Welche Labels es gibt, steht pro Laden unter Einstellungen → Läden bearbeiten (`settings.stores`); am Eintrag in der Spalte `shop` als `Edeka|Aldi`
- **Kassenzettel** (Bon-Symbol oben rechts): PDF (Rewe, Penny, dm, Rossmann …) oder Foto/Screenshot (Lidl Plus, Papierbon) hochladen. Oder „Aus Zwischenablage einfügen“: kopiertes Bild, PDF oder Bon-Text (iPhone fragt kurz „Einsetzen“; ist der Zugriff gesperrt, erscheint ein Feld zum Einsetzen; Strg+V geht auch). Erkannt werden Geschäft, Datum, Summe und jede Zeile mit Menge, Kilopreis und Rabatt (`src/receipt.js`). Jede Zeile wird einem Artikel zugeordnet (Vorschläge über Wortanfänge, `public/receipt.js`), als neuer Artikel angelegt oder ignoriert; die Zuordnung merkt sich die App je Geschäft (`receipt_alias`). Sachen, die auf der Liste standen, werden auf Wunsch abgehakt. Im Bearbeiten-Dialog steht danach „Zuletzt bezahlt“ je Geschäft. PDFs werden im Browser mit pdf.js gelesen (`public/vendor/`), Fotos mit Workers AI (Binding `AI`, kostenloses Tageskontingent); Bilder werden nicht gespeichert
- **Angebote** (Etikett-Symbol oben rechts → „Preise“): Gesucht wird nur für markierte Artikel: Stift am Eintrag → Schalter **„Angebote suchen“**, dann genau nach dem Begriff bei „Angebote suchen als“ (steht vor dem Schalter, damit man ihn vorher prüfen kann) (marktguru, inoffiziell, private Nutzung; Cron alle 5 Minuten ein paar Artikel, jeder etwa alle 8 Stunden; Knopf „Neue Angebote suchen“ sofort). Geschäfte in der Nähe und PLZ unter „ändern“ (abweichende PLZ je Geschäft möglich). Treffer müssen jedes Wort des Suchbegriffs enthalten. Es zählt der günstigste Grundpreis (Bio wird nur gekennzeichnet). Markierte Einträge zeigen in der Liste ein Etikett (und eine Glocke bei Preiswecker) mit dem besten Angebot. Tabellen `offers` (ein Jahr für den Preisverlauf) und `offer_watch` (`search`, `alarm`)
- **Ladenvergleich** (Reiter in „Preise“): Was kostet die offene Liste je Geschäft? Gerechnet mit aktuellem Angebot, sonst letztem Kassenzettel-Preis; fehlende Preise werden mit dem mittleren Preis der anderen Geschäfte geschätzt („~“). Dazu der „günstigste Mix“
- **Statistik** (Diagramm-Symbol oben rechts; nur noch aus Kassenzetteln): Woche, Monat oder Jahr, mit ‹ › blättern, nach Laden filtern. Ausgaben: Summe der Kassenzettel im Zeitraum, Verlauf der letzten 12 Wochen, nach Geschäft; dazu „Laut Kassenzettel gekauft“: jeder wirklich gekaufte Artikel mit Menge und Betrag (sortierbar nach Betrag, Menge, A–Z; `/api/receipt-lines`)
- Angebote: innerhalb eines Artikels steht zuerst, was ihr laut Kassenzettel schon gekauft habt (Kennzeichen „schon gekauft“): im selben Geschäft, wenn der Bon-Text nichts anderes sagt oder Sorte/Marke passen; in anderen Geschäften nur, wenn die Marke des Angebots auf dem Bon steht, danach nach Grundpreis
- **Preisverlauf** (Bearbeiten-Dialog → „Preisverlauf ansehen“): Kassenzettel-Preise (Punkte) und Angebote (Striche) je Geschäft, je Stück bzw. je kg
- **Preiswecker** (Bearbeiten-Dialog, schaltet „Angebote suchen“ mit ein): Nachricht an alle Handys, sobald es ein Angebot gibt – auf Wunsch nur bis zu einem Höchstpreis; jedes Angebot wird nur einmal gemeldet
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
| `src/receipt.js`, `src/receipts-api.js` | Kassenzettel lesen, speichern, Preise (`/api/receipt/*`, `/api/receipts`, `/api/prices`) |
| `src/offers.js`, `src/offers-api.js` | Angebote (marktguru), Preiswecker, Ladenvergleich (`/api/offers*`, `/api/prices/latest`) |
| `public/prices.js` | Ansicht „Preise“: Angebote, Ladenvergleich, Preisverlauf, Preiswecker |
| `public/receipt.js`, `public/vendor/pdf*.mjs` | Kassenzettel-Oberfläche; pdf.js (Apache-2.0, Mozilla) |
| `migrations/` | Änderungen für eine bestehende Datenbank |
| `public/icon*.png`, `public/manifest.webmanifest` | Icon und App-Manifest (öffentlich) |
| `d1-schema.sql` | Tabellen `items`, `settings`, `login_attempts`, `push_subs`, `purchases` (für eine neue Datenbank) |
| `wrangler.jsonc` | Cloudflare-Einstellungen (Datenbank `einkaufsliste-db`) |
| `test/worker.test.mjs` | Tests gegen eine lokale SQLite-Datenbank (`npm test`) |
| `test/e2e.mjs`, `test/e2e-kassenzettel.mjs` | Klicktests im Browser (lokal, brauchen Playwright bzw. pdf-lib) |

Das Passwort liegt nur als PBKDF2-Hash in `settings` (`pw_salt`, `pw_hash`). Nach 10 Fehlversuchen in 15 Minuten wird eine IP kurz gesperrt.
`settings.rev` ist ein Änderungszähler: Die Seite lädt die Liste nur neu, wenn er sich geändert hat.

Benachrichtigungen laufen über die Push-Dienste von Apple/Google, die der Browser selbst mitbringt – kostenlos, ohne Konto. Der Schlüssel dafür (VAPID) entsteht beim ersten Einschalten automatisch und liegt in `settings`.

## Kosten

Alles bleibt im kostenlosen Cloudflare-Tarif (Workers Free: 100.000 Aufrufe/Tag, D1 Free: 5 Mio. gelesene Zeilen/Tag, Workers AI Free: 10.000 Neurons/Tag – reicht für viele Kassenzettel-Fotos am Tag; ist es aufgebraucht, klappt das Foto-Lesen erst am nächsten Tag wieder, es entstehen keine Kosten).
Ein offenes Handy erzeugt ca. 900 Aufrufe pro Stunde; im Hintergrund fragt die Seite nicht nach.

## Veröffentlichen (Deploy)

Cloudflare baut und veröffentlicht automatisch bei jedem Push auf `main` (Workers Builds, mit GitHub verbunden).
Manuell: `npm install && npx wrangler deploy`.

**Test-App für neue Funktionen:** Eigener Worker `einkaufsliste-test` (mit demselben Repo verbunden, Produktions-Branch = Feature-Branch, Deploy-Befehl `npx wrangler deploy --env test`). Er nutzt die Datenbank `einkaufsliste-test-db` und zeigt oben eine rote Leiste „TEST-VERSION“. Adresse: `einkaufsliste-test.<subdomain>.workers.dev`.

## Datenbank neu aufsetzen

```sh
npx wrangler d1 create einkaufsliste-db            # ID in wrangler.jsonc eintragen
npx wrangler d1 execute einkaufsliste-db --remote --file=d1-schema.sql
```

Danach in der Tabelle `settings` `pw_salt`, `pw_hash` (PBKDF2-SHA256, 100.000 Runden, hex) und `session_secret` (64 Hex-Zeichen) setzen.
