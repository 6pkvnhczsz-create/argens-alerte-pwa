# Gemessener Regen bei wechselnder Heimatstation (FR/EN/DE)

Diese Version erweitert ausschließlich den **informativen Vorhersagen-Tab** bei einer anderen gewählten französischen Heimat-Pegelstation als Roquebrune (Y531201001).

## Datenweg

1. `/api/rain/station?station=...` bestätigt die gewählte Station über die bestehende amtliche Hub'Eau-Referenz; nur deren geographische Position darf für die Regensuche genutzt werden.
2. Der öffentliche Push-Worker registriert höchstens 40 aktive ausgewählte Stationen für bis zu 24 Stunden in der **gemeinsam genutzten Cloudflare-D1-Datenbank** `argens-alerte-db`. Er hat **keinen** Météo-France-API-Key und fragt niemals Météo-France direkt ab.
3. Der bereits geschützte Admin-Worker holt alle 15 Minuten den offiziellen `/public/DPObs/v2/liste-stations`-Katalog über das vorhandene verschlüsselte Secret `METEO_FRANCE_OBS_API_KEY`. Er wählt pro gewählter Heimatstation höchstens drei Météo-France-Stationen im Umkreis von 50 km (Luftlinie) und erfasst deren echte stündliche RR1-Messungen in der bestehenden D1-Tabelle `forecast_shadow_rain`. Der Katalog wird 24 Stunden vorgehalten. Gemeinsame Météo-Stationen werden dedupliziert.
4. Stündliche Werte sind nur gültig, wenn Station, Zeitstempel und RR1 zusammenpassen. Keine Antwort, `null`, HTTP-Fehler oder einzelne Messlücken werden nie zu 0 mm umgedeutet.
5. Für 3h und 6h werden jeweils vollständige reale Stundenmessungen mit mindestens zwei Wetterstationen pro Stunde benötigt. Bei 24h wird die Summe nur bei vollständigen 24 Stunden ausgegeben. Alle gemessenen Werte sind das ungewichtete Mittel nahe gelegener Regenstationen, **keine Messung des flussaufwärtsliegenden Einzugsgebiets**.
6. Sind noch nicht genügend echte Messungen vorhanden, bleibt die bisherige **Open-Meteo-Schätzung** verfügbar. Die App markiert diesen Zustand explizit als `Modellschätzung / model estimate / estimation du modèle`, nicht als Météo-France-Messwert. Für neue Stationen kann ein Backfill mehrere automatische 15-Minuten-Zyklen beanspruchen.

## Grenzen & bestehendes Verhalten

- Der Argens-spezifische Standardmodus mit drei Gebietszeilen bleibt vorerst **unverändert**. Er muss bei einem eigenen Schritt anhand der genauen Messstationszuordnung zu den drei Gebietszonen ersetzt werden. Diese Erweiterung gilt nur bei **gewechselter Heimatstation**.
- Für alle Stationen werden die **zukünftigen** Regenprognosen weiter von AROME/ARPEGE via Open-Meteo bezogen; die Observations-API liefert nur vergangene Stunden.
- Das Datenbudget bleibt begrenzt: Admin-Worker führt je 15-Minuten-Lauf **höchstens 25 zusätzliche** API-Anfragen aus, zusätzlich zu bisherigem Argens-Import (maximal 55 Anfragen). Für 40 Stationen können einige Stationen zeitweise nur Schätzwerte bekommen. Eine öffentlich skalierte Nutzung erfordert ein regionales Queue-/Fairness-Design sowie gegebenenfalls die Paket-Observations-API.
- Es handelt sich um eine **lokale Näherung** bei Radius 50 km und nicht um eine hydrologisch geprüfte Einzugsgebiets-Regenbilanz. Bei flussaufwärts weit entfernten Niederschlagszentren können die lokalen Messungen für Hochwasserrisiken unzureichend sein.
- **Kein Einfluss auf Push-Warnungen**, Schwellen, automatische Risikoberechnung oder die experimentelle Admin-Hochwasserprognose.

## Deployment

- Cloudflare Workers `argens-alerte-admin` und `argens-alerte-push` müssen nach dem GitHub-Merge beide den aktualisierten Code übernehmen.
- Beide Worker müssen weiterhin dieselbe D1-Datenbank `argens-alerte-db` verwenden.
- Das bereits hinterlegte Secret bleibt **nur** beim Admin-Worker.
- Im öffentlichen Vorhersagen-Tab eine Heimatstation außerhalb der Argens wählen und prüfen, ob nach den automatischen Messläufen „Gemessener Niederschlag · Météo-France“ erscheint. Solange nicht genügend reale Messungen vorliegen, muss eindeutig „Modellschätzung“ stehen.
- Der neue Regenstationskatalog muss für verschiedene Regionen zumindest zwei plausible Stationen finden; beim Live-Test mit einer echten API-Berechtigung prüfen. CI kann Offline-Parsing und Zeitabgleiche testen, aber keine echten Météo-France-Antworten validieren.

Amtliche Hinweise:
- https://www.data.gouv.fr/dataservices/api-donnees-dobservation
- https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/853639294/API+Cibl%C3%A9e+Obs+FR
