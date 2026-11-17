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
3. Sicherstellen, dass der stündliche Cron-Trigger mit dem Admin-Worker ausgerollt ist. Ohne Secret zeichnet die Testansicht ausdrücklich „Secret fehlt“ und speichert keine neuen Messwerte.
4. Die Seite `/forecast-shadow` hinter Cloudflare Access öffnen. Prüfen, ob `Letzter Import` und die Stationen erscheinen. Bei 401/403 im Import: API-Berechtigung/Konto prüfen; bei fehlendem `rr1` nicht automatisch auf null setzen.
5. Es dauert nach der Aktivierung bis zu zehn Tage, bis eine volle zehntägige Historie live angesammelt wurde (sofern die Quellen berichten). Vorhandene lokale CSV-Archive wurden **nicht** ungeprüft als Live-Messungen importiert.

## Offene Punkte vor der *echten* Modellprognose

1. Offizielle API-Rückgaben mit realen Credentials für alle elf historischen Stationskennungen prüfen. Historisch verfügbare Stationen können aktuell inaktiv sein; nicht automatisch wechseln.
2. Eingabemerkmale gegen das in `riviere_alerte_prognose_prototyp.zip` gespeicherte Python-Modell exakt reproduzieren; das Joblib-Format läuft nicht im Cloudflare-Worker. Gesonderter abgesicherter Python-Inferenzdienst oder validierter JS-Export erforderlich.
3. Historische Rücktestvektoren und Online-Eingaben bis auf Toleranzen vergleichen; 2019 wurde im separaten Rücktest noch unzureichend erkannt.
4. Prognosen stündlich persistieren und 6 Stunden später mit dem tatsächlich eingetretenen **Maximum** vergleichen. Noch nicht implementiert, da derzeit bewusst keine gültigen Prognosezahlen erzeugt werden.
5. Erst nach ausreichend unabhängigen Hochwasser-Rücktests über eine öffentliche Prognose entscheiden; Warnlogik unverändert lassen.

## API / Sicherheit

- Nur im existierenden Cloudflare-Access-geschützten Admin-Worker.
- Bei fehlenden/alten Messwerten ist `prediction.forecast_peak_m` immer `null`.
- API-Token verbleibt ausschließlich als Cloudflare-Secret; Admin-API gibt nur `api_key_configured` zurück.
- Zugangskontrolle folgt dem bestehenden Admin-Worker; Cloudflare Access muss **vor** dem Worker sämtlichen Traffic schützen. Dieser Zweig ersetzt keine Access-Policy.

## Tests

```sh
node --check admin-worker/src/index.js
node --check admin-worker/src/forecast-shadow.js
node --test admin-worker/test/forecast-shadow.test.mjs
```

Quellen: https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/853639294/API+Cibl%C3%A9e+Obs+FR ; https://www.data.gouv.fr/dataservices/api-donnees-dobservation
