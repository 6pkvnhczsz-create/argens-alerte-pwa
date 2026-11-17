# Experimentelle Hochwasserprognose – Vorbereitungsstufe (nur Admin)

Stand: 17. November 2026. **Kein produktives Vorhersagemodell und keine Alarmquelle.**

## Was der Entwicklungszweig tatsächlich implementiert

- Ein zusätzlicher Link **Prognose-Test** im bestehenden Cloudflare-Access-geschützten Admin-Portal.
- `GET /forecast-shadow`: separate, rein deutschsprachige Statusansicht.
- `GET /api/forecast-shadow`: schreibgeschützter Daten-/Qualitätsstatus, kein prognostizierter Pegel.
- Stündlicher geplanter Lauf (Minute 31 UTC) im **separaten Admin-Worker**.
- Abruf offizieller stündlicher Beobachtungen (RR1) für elf Météo-France-Stationen; Rückgriff auf die letzten drei UTC-Stunden bei Verzögerungen.
- Speicherung in der bestehenden Cloudflare-D1-Datenbank, eigenes Namespace `forecast_shadow_*`, automatische Löschung nach 15 Tagen.
- Kontrolle: ein aktueller Pegel (Hub’Eau, höchstens 60 Minuten alt), mindestens sieben frische Regenstationen und bei mindestens sieben Stationen mindestens 216/240 Stunden der zurückliegenden zehn Tage.
- Liegt die Regenhistorie nicht vor, wird **keine Regenmenge erfunden**. Ebenso wird **nie eine numerische 6-h-Prognose** angezeigt, bevor der Python-Modelladapter getrennt implementiert und validiert ist.

Die bestehenden Alarmregeln, +40 cm/h, Nutzerschwellen, D1-Nutzerkonten, Push-Worker, öffentliche FR/EN-Seite und öffentliche API bleiben unberührt.

## Aktivierung nach fachlicher Prüfung

1. PR prüfen, Tests ausführen, erst dann in `main` übernehmen. Workers Builds deployt den Admin-Worker anhand `admin-worker/wrangler.jsonc`.
2. In Cloudflare bei **argens-alerte-admin** ein **verschlüsseltes Secret** `METEO_FRANCE_OBS_API_KEY` setzen. Der Schlüssel muss auf dem Météo-France-Portal für **API Données d'observation** freigeschaltet sein. Ein Schlüssel für die Vigilance-API ist nicht automatisch dazu berechtigt. Schlüssel nie in GitHub/Chat einfügen.
3. Im Admin-Portal unter **Prognose-Test** auf **Météo-France-Verbindung testen** klicken. Der Test führt genau einen geschützten GET-Aufruf an die Observations-API aus und zeigt HTTP 401/403/429 gesondert an. HTTP 200 bestätigt zunächst nur den API-Zugriff; ein stündlicher RR1-Wert ist zusätzlich erforderlich, damit eine Messung vorliegt.
4. Sicherstellen, dass der stündliche Cron-Trigger mit dem Admin-Worker ausgerollt ist. Ohne Secret zeichnet die Testansicht ausdrücklich „Secret fehlt“ und speichert keine neuen Messwerte.
5. Die Seite `/forecast-shadow` hinter Cloudflare Access öffnen. Prüfen, ob `Letzter Import` und die Stationen erscheinen. Bei 401/403 im Import: API-Berechtigung/Konto prüfen; bei fehlendem `rr1` nicht automatisch auf null setzen.
6. Die zehn Tage können durch den explizit gekennzeichneten historischen CSV-Snapshot temporär ergänzt werden, sofern er im rollenden Zeitfenster liegt (sofern die Quellen berichten). Vorhandene lokale CSV-Archive wurden **nicht** ungeprüft als Live-Messungen importiert.

## Offene Punkte vor der *echten* Modellprognose

1. Offizielle API-Rückgaben mit realen Credentials für alle elf historischen Stationskennungen prüfen. Historisch verfügbare Stationen können aktuell inaktiv sein; nicht automatisch wechseln.
2. Eingabemerkmale gegen das in `riviere_alerte_prognose_prototyp.zip` gespeicherte Python-Modell exakt reproduzieren; das Joblib-Format läuft nicht im Cloudflare-Worker. Gesonderter abgesicherter Python-Inferenzdienst oder validierter JS-Export erforderlich.
3. Historische Rücktestvektoren und Online-Eingaben bis auf Toleranzen vergleichen; 2019 wurde im separaten Rücktest noch unzureichend erkannt.
4. Prognosen stündlich persistieren und 6 Stunden später mit dem tatsächlich eingetretenen **Maximum** vergleichen. Noch nicht implementiert, da derzeit bewusst keine gültigen Prognosezahlen erzeugt werden.
5. Erst nach ausreichend unabhängigen Hochwasser-Rücktests über eine öffentliche Prognose entscheiden; Warnlogik unverändert lassen.

## API / Sicherheit

- Nur im existierenden Cloudflare-Access-geschützten Admin-Worker.
- Bei fehlenden/alten Messwerten ist `prediction.forecast_peak_m` immer `null`.
- API-Token verbleibt ausschließlich als Cloudflare-Secret; Admin-API gibt nur `api_key_configured` zurück. Der POST-Endpunkt `/api/forecast-shadow/probe` prüft mit einer Anfrage die Zugriffsberechtigung, liefert ausschließlich zusammengefasste Status- und Messwerte und ist durch Cloudflare Access sowie Same-Origin geschützt.
- Zugangskontrolle folgt dem bestehenden Admin-Worker; Cloudflare Access muss **vor** dem Worker sämtlichen Traffic schützen. Dieser Zweig ersetzt keine Access-Policy.

## Tests

```sh
node --check admin-worker/src/index.js
node --check admin-worker/src/forecast-shadow.js
node --test admin-worker/test/forecast-shadow.test.mjs
```

Quellen: https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/853639294/API+Cibl%C3%A9e+Obs+FR ; https://www.data.gouv.fr/dataservices/api-donnees-dobservation

## Importkorrektur 17.11.2026

Der erste Test zeigte HTTP 400 bei allen 33 automatischen Anfragen, während der manuelle API-Test für Les Mayons erfolgreich war. Die Ursache war eine unterschiedliche Datumsformatierung: Der Cron verwendete ISO-Timestamps mit Millisekunden (`...:00.000Z`), der erfolgreiche Einzeltest ohne Millisekunden (`...:00Z`). Der Import verwendet nun einheitlich das von Météo-France dokumentierte Format `YYYY-MM-DDTHH:mm:ssZ` und ruft ausschließlich die drei bereits abgeschlossenen UTC-Stunden ab.

Im Access-geschützten Admin-Bereich ist **Regenimport jetzt starten** verfügbar. Diese Aktion stößt den Import im Hintergrund des Workers an; das Ergebnis erscheint erst nach Abschluss beim Klick auf **Aktualisieren**. Höchstens ein manueller Import innerhalb von zwei Minuten. Ein grüner API-Einzeltest allein bestätigt noch nicht, dass alle elf Stationen stündliche RR1-Werte liefern. Fehlende Werte bleiben ausdrücklich fehlend und werden nicht als 0 mm eingetragen.

Die Änderung ist auf Regenimport und Admin-Test beschränkt; keine Auswirkungen auf Warnschwellen oder Push-Benachrichtigungen.

## Prognose-Test – Stufe 1: Risiko-/Schwellenansicht und historisches Regenarchiv

- Die Admin-Ansicht zeigt nun **eine** kompakte experimentelle 6-h-Risikozeile und die drei lokalen Schwellen 5,40 m (Straße/Grundstück), 5,90 m (Zaun/Grundstück) und 6,22 m (Haustür).
- Der **bereits gemessene** Status jeder Schwelle wird getrennt von der **noch nicht freigegebenen** Modellvorhersage ausgewiesen. Die Anzeige darf niemals aus fehlenden Features eine beruhigende oder alarmierende sechs Stunden umfassende Prognose ableiten.
- Einzeilige Datenübersicht: Pegel, gemessene regionale Regenmengen in den letzten 24 Stunden und 10 Tagen, Zahl frischer Wetterstationen. Details der Wetterstationen liegen zugeklappt unter „Messstationen und technische Details“.
- Nur beobachtete Messsignale (bereits erreichte 5,40 m, mindestens +40 cm/h gemessener Anstieg, regional mindestens 50 mm/24 h) dürfen als **Messsignal, keine Prognose** erscheinen. Die bereits bestehenden Alarmroutinen werden hiervon **nicht** berührt.
- Historische Niederschlagsdaten vom 7. bis 16. November 2026 sind als kleiner, qualitätsgeprüfter, schreibgeschützter CSV-Snapshot aus den vom Nutzer bereitgestellten Météo-France-Archiven im Admin-Worker hinterlegt. Fehlende Stunden bleiben fehlend, echte 0-mm-Stunden bleiben 0 mm; frische Live-Daten überschreiben bei Überschneidungen historische Werte.
- Der Snapshot wird **nur innerhalb der rollenden letzten 240 Stunden** berücksichtigt und fällt danach automatisch aus der Datenbasis; er wird nicht als Live-Datenquelle dargestellt. Kein Schreibzugriff auf Tabellen für Archivdaten notwendig.
- Für Regen-Gebietsmittel gilt: nur Stunden mit mindestens 7 der 11 Stationen. Die 24-h- bzw. 240-h-Menge erscheint nur, wenn mindestens 80 % dieser Stunden ausreichend gemessen wurden. Sonst wird **kein** Zahlenwert ausgegeben.
- Das historische Archiv kann die 10-Tage-Datenlücke überbrücken; es ist aber nicht garantiert, dass die neuesten 24 Stunden lückenlos sind. Der Live-Import muss selbstständig weiterlaufen.
- Die archivierte Nachfüllung ersetzt **keinen** lauffähigen Python-Modelladapter. Für eine 6-h-Schwellenüberschreitungsprognose bleibt `prediction.forecast_peak_m` unverändert `null`. Die 2019er Rücktests mahnen zusätzlich zur Vorsicht.

**Sicherheit:** Nur Cloudflare-Access-geschützter Admin, deutschsprachig. Keine Änderungen an öffentlicher App, Push-Worker, Warnschwellen oder Alarmen. Die Tabelle im Admin-Popup zeigt beobachtete Daten, keine amtliche Hochwasserprognose.
