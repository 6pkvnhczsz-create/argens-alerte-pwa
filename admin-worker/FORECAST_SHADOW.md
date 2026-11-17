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

## Stufe 2 (experimentell): tatsächliche 6-Stunden-Pegelschätzung im Admin

Die Cloudflare-JavaScript-Laufzeit kann das `joblib`-Objekt nicht direkt laden. Aus dem bereits trainierten und bis 2023 eingefrorenen Hydro+Regen-HistGradientBoosting-Modell wurde deshalb **ausschließlich auf Trainingsdaten 2015–2023** ein kleiner Entscheidungsbaum mit 24 Blättern zur Approximation seiner sechs Stunden vorausblickenden Höchststandschätzung abgeleitet. Die Baumstruktur liegt als explizite Konstanten in `src/forecast-shadow-model.js` und läuft **ohne externe Modellinfrastruktur** im Admin-Worker. Das ist ein **destilliertes Modell**, nicht das volle ursprüngliche Python-Modell.

### Rücktest der kompakten Version

- Unabhängig im Kalender getesteter Zeitraum: 2024–2026, 9.679 auswertbare stündliche Zeitpunkte.
- Gesamter durchschnittlicher Absolutfehler: **0,070 m**, hauptsächlich bei niedrigen Pegeln gemessen und deshalb kein Beweis für ausreichende Hochwasser-Vorhersageleistung.
- Vor Erreichen der 5,40-m-Schwelle: **10 von 13** positiven, zeitlich überlappenden Vorhersagefenstern erkannt; **acht** fälschliche Überschreitungsfenster. Die Fenster stammen aus wenigen voneinander unabhängigen Ereignissen.
- Der Baum hat insbesondere das Hochwasser vom **21. Oktober 2026 erheblich überschätzt**. Es gibt keine kalibrierte Wahrscheinlichkeit und kein zuverlässiges Prognoseintervall.
- Die unabhängige Prüfung des **ursprünglichen** Regenmodells an 2019 zeigte ebenfalls Schwächen. Das Schattenmodell ist daher **nicht als Warnsystem validiert**.

### Live-Featureberechnung

- Für jeden Bezugszeitpunkt werden aktuelle Höhenbeobachtungen der Station Y531201001 aus Hub’Eau und nur tatsächlich vorliegende Regenstunden aus Météo-France verwendet.
- Regenfeatures sind dieselben ungewichteten Regionsmittel und rollenden Summen wie im historischen Training: für Argens/Aille/Bresque/Nartuby/Oberlauf die letzten 6,24,72,240 Stunden und für das Gesamtgebiet die letzten 1,3,6,12,24,72,240 Stunden.
- Daten aus der CSV-Starthilfe vom 7.–16.11.2026 werden nur verwendet, solange sie innerhalb des letzten 240-Stunden-Fensters liegen. Der fortlaufende Live-Import ersetzt sie stündlich.
- Kein Zahlenwert bei fehlender frischer Hub’Eau-Messung (max. 60 Minuten), weniger als sieben historischen Regenstationen mit hinreichend vollständiger 10-Tage-Abdeckung, fehlenden 24-/72-Stunden-Regendaten oder mehr als zwei Stunden alter gemeinsamer Regen-/Pegel-Bezugszeit.
- Das Modell wird auf dem **letzten gemeinsamen vollen UTC-Stundenwert** ausgeführt. Der tatsächliche Prognoseendzeitpunkt wird angezeigt (Bezugszeit + 6 Stunden); dies ist nicht unbesehen „6 Stunden ab dem aktuellen Browserzeitpunkt“.
- Das gefundene Modellmaximum wird nicht unter dem aktuellen gemessenen Pegel ausgewiesen; starke aktuelle Pegelanstiege bleiben separat als Messsignal sichtbar. Eine vorhergesagte Schwellenüberschreitung ist **nur eine experimentelle Modellindikation**, nie eine Push-Warnung.

### Sicherheit

- Nur unter Cloudflare Access im separaten **deutschen** Admin-Worker auf `/forecast-shadow`; Endpunkt `GET /api/forecast-shadow`.
- Die Seite zeigt nur bei wirklich berechenbarer Schätzung eine Zahl; sonst einen konkreten Grund für das Fehlen. Die drei Schwellen 5,40 / 5,90 / 6,22 m zeigen gemessenen und experimentell geschätzten Status getrennt.
- Öffentliche Seite, Push-Service, +40 cm/h-Schnellanstieg, Nutzergrenzen und amtliche Hinweise bleiben **unverändert**. Die Modellzahl ist ausdrücklich weder amtliche Vorhersage noch Entwarnung.
- Modellvalidität und Fehlalarme sollten weiter überwacht werden, bevor weitere Schritte erwogen werden.

### Zusätzliche Tests

`node --test admin-worker/test/forecast-shadow.test.mjs` vergleicht Baumwerte mit golden predictions aus Python/scikit-learn (März und Oktober 2024) und testet Datenlücken, Zeitbezug, D1/Hub’Eau-Integration sowie das Blockieren der Modellzahl bei unbrauchbaren Eingaben.

## 17.11.2026 – Lücke im letzten 24-Stunden-Fenster schließen

Das Dashboard zeigte 11/11 frische Stationen und 10/11 mit ausreichender 10-Tage-Abdeckung, aber nur **8/20** verwertbare regionale Regenstunden der letzten 24 Stunden. Die ältere CSV-Starthilfe endet am 16.11. und die neue Live-Abfrage hat erst ab dem 17.11. Regenmessungen gespeichert. Deshalb sperrt das Prognosemodell korrekt seine Ausgabe, statt fehlenden Regen als 0 mm zu interpretieren.

**Nachladen:** Der neue Admin-Knopf **„Fehlende Regenstunden nachladen“** ruft die Météo-France-Observations-API für fehlende, höchstens 23 Stunden und 45 Minuten alte Stundenwerte ab. Er lässt bestehende Archive und Live-Messwerte unverändert und nimmt maximal 55 API-Anfragen pro Klick vor. Eine 2-Minuten-Sperre verhindert parallele Wiederholungen; nicht erhältliche Stundenwerte erhalten einen 30-Minuten-Retry-Cooldown und werden nie als 0 mm gespeichert. Die Funktion arbeitet ausschließlich innerhalb der vorhandenen Access-geschützten Admin-Umgebung und benötigt keine neuen Secrets.

Der bereits vorhandene stündliche Cron ruft nach den regulären 33 Messanfragen automatisch zusätzlich maximal 22 fehlende Messungen ab (maximal 55 zeitlich naheliegende Anfragen pro normalem Stundenlauf). Die dokumentierte Grenze der gezielten Observations-API beträgt 100 Requests/Minute; andernfalls bei HTTP 429 sofort abbrechen. Das manuelle Nachladen ist optional und kann die Nachfüllung beschleunigen. Es kann mehrere begrenzte Durchläufe brauchen, bis mindestens 20/24 Stunden eine gültige Gebiets-Mittelung aus mindestens sieben Stationen ermöglichen.

**Keine automatische Hochwasserwarnung:** Nur die Regen-Datenlücke wird geschlossen; die experimentelle Schwellenprognose bleibt getrennt von allen Warnungen und lässt sich nur bei genügender Datenqualität berechnen. Die exakte Wirkung ist erst nach Cloudflare-Deployment und tatsächlichem API-Rücklauf verifiziert.

Offizielle Quelle: https://www.data.gouv.fr/dataservices/api-donnees-dobservation (24 Stunden Aufbewahrungsfenster, 100 Anfragen/Minute); https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/853639294/API+Cibl%C3%A9e+Obs+FR

## 17.11.2026 – Nachladen und Dashboard vollständig automatisiert

Die Übergangslücke von historischem Météo-France-CSV zu laufendem Echtzeitimport wird **ohne manuelle Betätigung** geschlossen, soweit Météo-France die echten Stundenwerte im offiziellen 24h-Zeitfenster noch bereitstellt.

**Cloudflare Cron Triggers (UTC):**
- `31 * * * *`: bisheriger regulärer Import, maximal 33 Beobachtungen (3 abgeschlossene Stunden × 11 Stationen), danach maximal 22 fehlende Stundenwerte nachholen.
- `1,16,46 * * * *`: zusätzlich drei reine Nachladeläufe je Stunde mit maximal 55 fehlenden Stundenwerten. Insgesamt wird also alle 15 Minuten ein möglicher Nachladeversuch angestoßen (01, 16, 31, 46 UTC).
- Erfolgreich gespeicherte Werte und bereits im CSV-Snapshot vorhandene Stunden werden ausgelassen. Fehlende Werte werden nie als 0 mm gespeichert. Ein Retry-Cooldown von 30 Minuten für ungültige RR1-Antworten und die schon vorhandene parallele 2-Minuten-Sperre bleiben bestehen.
- Die Obergrenze von 55 Anfragen pro Durchlauf (bzw. 33+22 beim normalen Import) hält reguläre Lastspitzen deutlich unter 100 API-Anfragen pro Minute. Externe 429-Fehler brechen Nachladung ab und werden im Admin vermerkt. Kein neuer Secret, kein zusätzlicher Dienst, kein separates ChatGPT-Reminder notwendig.
- Die neue Berechnung im bestehenden `GET /api/forecast-shadow` erfolgt **bereits bei jedem Abruf aus den aktuell gespeicherten Daten**. Sobald die Feature-Anforderungen erfüllt sind, wird automatisch die experimentelle 6-h-Pegelzahl ausgegeben. Es wird keine Prognose aktiv an Nutzer gepusht.
- Das Admin-Frontend ruft den Status selbständig jede Minute neu ab, solange die Seite sichtbar ist. Bei geschlossener Admin-Seite arbeitet der Cloudflare-Cron trotzdem weiter. Der manuelle Nachladebutton bleibt nur als Fehlerdiagnose unter den aufgeklappten technischen Details.
- **Deployment kontrollieren:** Ein GitHub-Merge allein bestätigt noch nicht, dass die neuen Cloudflare Cron Triggers aus `admin-worker/wrangler.jsonc` in der tatsächlichen Worker-Deployment-Konfiguration aktiv sind. Nach Veröffentlichung in Cloudflare unter dem Worker `argens-alerte-admin` die registrierten Cron Triggers kontrollieren. Bei fehlenden Triggern die Admin-Worker-Build-/Deploy-Konfiguration prüfen.

Das Experiment ist nicht als zuverlässige Hochwasserwarnung validiert. Die öffentliche FR/EN-Seite, Push-Worker, Warnschwellen und bestehende Alarmregeln sind weiterhin unangetastet.

## 17.11.2026 – Stündliche Pegelquelle / kurze Verzögerung (experimenteller Admin-Preview)

Bei 21/24 vollständigen Regenstunden und 11/11 Wetterstationen sperrte die **strenge 60-Minuten-Prüfung** den Pegelwert von 15:00 Uhr im Admin-Screenshot um 16:02 Uhr (Alter 62 Minuten). Für die öffentliche Warnlogik bleibt die bestehende Frischeprüfung unverändert: **kein veralteter Messwert wird als „aktuell“ eingestuft**.

Der separate, ausschließlich interne 6-h-Schattenmodell-Adapter darf nun eine **maximal 90 Minuten alte, eindeutig zeitgestempelte Originalbeobachtung von Hub’Eau** als verzögerte *experimentelle* Rechnung verwenden, falls alle übrigen Modellprüfungen erfüllt sind. Dabei:
- Status `experimental_delayed`, UI **„Verzögerte Testrechnung“**, sichtbar: Alter des Pegelwerts und tatsächlicher Modell-Bezugszeitpunkt. Keine Prognose „sechs Stunden ab jetzt“, wenn der Bezugszeitpunkt älter ist.
- Der gemessene Schwellenstatus bleibt bei veralteten Pegeln ausdrücklich **„unbekannt“**; nur die separate nicht-validierte Modellschätzung wird gezeigt.
- Bei mehr als 90 Minuten, unklarer Quelle, fehlenden oder ungültigen Zeitstempeln bleibt die Modellzahl komplett gesperrt.
- Keine Änderungen an Push, öffentlichen Alarmen, voreingestellten Warnschwellen, Schnellanstieg +40 cm/h, Regenimport, Météo-France-API, Cloudflare-Crons oder Cloudflare-Secrets.
- Eine zeitlich noch zulässige Prognose kann trotzdem ausfallen, wenn Météo-France oder Hub’Eau am gewählten gemeinsamen Modell-Bezugszeitpunkt nicht genügend geprüfte Beobachtungen liefern.

Prüfung: Unit-Test mit 62 Minuten verspätetem Pegelwert (Modellschätzung verzögert, gemessene Schwelle unbekannt) und 91 Minuten altem Wert (weiterhin blockiert).

**Die geschätzte Höhe ist kein belastbarer Hochwasserschutzentscheid und niemals eine Entwarnung.** Für echte Gefahren maßgeblich bleiben gemessene Wasserstände, amtliche Informationen und die separaten bestehenden Warnregeln.
