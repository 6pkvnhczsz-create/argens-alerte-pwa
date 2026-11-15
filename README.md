# argens-alerte-pwa

Admin-Worker deployment: Cloudflare Workers Builds uses `admin-worker/wrangler.jsonc` on the `main` branch. The admin UI remains protected by Cloudflare Access.

## Vigicrues backup (water levels)

Primary source is Hub’Eau (PHyC). If its readings fail validation or are older than three hours, the push Worker falls back to Vigicrues observations for the **same station**. The static PWA queries Hub’Eau directly and calls the read-only push Worker endpoint only when that request fails:

`GET /api/vigicrues-backup?station=Y531201001`

Vigicrues delivers heights in **metres**; the Worker converts them to **millimetres**, the same unit as Hub’Eau. The backup must provide at least two plausible observations, with a fresh timestamp (maximum 3 hours old, 15-minute future tolerance). If both sources fail, do not present a current warning level or send a warning based on stale observations. The PWA displays the active source and an explicit unavailable state. The German-only admin shows separate Hub’Eau and Vigicrues service-health indicators.

Vigicrues observations use `https://www.vigicrues.gouv.fr/services/observations.json/index.php?CdStationHydro=<STATION>&GrdSerie=H&FormatDate=iso` and may change without notice. The upstream live endpoint has **not** been confirmed in this environment; validate on Cloudflare after deployment.

Offline regression tests (Node.js 18+):

```sh
node --test push-worker/test/water-sources.test.mjs
```

For rollout, deploy the **push Worker first** (new fallback endpoint and Admin RPC), followed by the public PWA and the admin Worker. Verify `/api/vigicrues-backup?station=Y531201001` returns a recent `observed_at`, `source: "vigicrues"`, and plausible millimetre measurements before relying on the backup in operation.

## GitHub Actions -> Cloudflare Vigicrues backup (Roquebrune)

The production fallback path uses the scheduled [Vigicrues backup to Cloudflare](.github/workflows/vigicrues-backup-sync.yml) workflow for **all actively selected stations**, discovered dynamically on every run. No manual repository edits are needed when a user adds or switches stations:

1. GitHub authenticates with the Cloudflare Worker using GitHub OIDC, then securely reads the distinct station codes selected by active accounts in `user_station_settings`, plus the mandatory Roquebrune home station `Y531201001`. It fetches official Vigicrues series for every selected code, independently verifying station, plausibility and age, and keeping at most 700 recent samples per station.
2. GitHub issues a short-lived OIDC identity JWT, scoped to the custom audience `riviere-alerte-vigicrues-sync`.
3. The job POSTs a separate snapshot for each supported station to `/api/vigicrues-ingest` on the push Worker. The Worker verifies the JWT cryptographic signature via GitHub's public JWKS **and** immutable repository/owner IDs, `main`, exact workflow and allowed event; no shared secrets are necessary.
4. The Worker stores each active station's snapshot under its own station code in the existing Cloudflare D1 binding. The public `/api/vigicrues-backup?station=STATION_CODE` endpoint and scheduled push checks consult it **only if Hub’Eau is unavailable**.
5. The German-only admin health dashboard shows the last backup measurement and **via GitHub Actions**.

Run frequency: every 5 minutes (GitHub Actions schedules can be late). The cached backup is only accepted while the last delivery is at most **75 minutes** old *and* the newest official observation is at most **3 hours** old. Otherwise the Worker rejects it and preserves the fail-closed no-current-alert behavior. The original direct Vigicrues endpoint remains a tertiary attempt but is currently HTTP 403 from Cloudflare. Stations not selected by any active user are not synchronized. Stations without a valid Vigicrues height series are explicitly **not backed up** (they are retried after a 6-hour cooldown, or 30 minutes for stale observations). Data for stations no longer selected is excluded immediately from fallback and cleaned up from storage after 30 days. The signed workflow processes at most 200 active station codes per run; exceeding that limit causes a visible workflow failure rather than silently dropping users, and requires scaling the job.

No changes to primary Hub’Eau retrieval, flood alert thresholds, or existing notification delivery. Dynamic discovery operates on the next GitHub scheduled execution (usually every 5 minutes, not instantaneous). The ingest endpoint never accepts unsigned/unauthorized measurements. The pipeline is not a guarantee of uninterrupted flood warnings: official Vigicrues/public safety guidance remains essential.

To verify the live pipeline, check the workflow's latest logs and read `/api/vigicrues-backup?station=Y531201001`. A functioning backup returns `ok:true`, `transport:"github-actions"`, a station code, a recent `observed_at` and observations in **millimetres**. Perform first deployment of the push Worker before relying on the new GitHub sync. The signed write is a different endpoint from the public read API.

Regression tests: `node --test push-worker/test/vigicrues-snapshot.test.mjs push-worker/test/water-sources.test.mjs` and `python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v`. The PR test workflow also syntax-checks the Python sync script.


## Frühindikatoren — Météo-France, Regen und Oberlieger

Im öffentlichen Bereich von Rivière Alerte gibt es eine zusätzliche, FR/EN/DE-übersetzte Informationsanzeige für das Argens-Einzugsgebiet rund um Roquebrune. Der bestehende Push-Worker aktualisiert die Anzeige im geplanten 5-Minuten-Lauf und speichert sie kurzzeitig in D1 (max. 25 Minuten). Public Read-API: GET /api/early-signals.

**Amtliche Météo-France-Warnungen für das Département Var (83):** Die Integration unterstützt die offizielle OAuth2-API Bulletin Vigilance (Endpunkt https://public-api.meteofrance.fr/public/DPVigilance/v1/cartevigilance/encours). Sie prüft die Zeitstempel und den Département-Code 83. Ohne gültiges Météo-France-Abonnement zeigt die App ausdrücklich „nicht verbunden“, niemals erfundene grüne Warnstufen. Der öffentliche Link zu https://vigilance.meteofrance.fr/fr/var bleibt unabhängig nutzbar.

**Alternativer API-Key (empfohlen, falls der OAuth2-Token-Dienst HTML statt JSON liefert):** Im Météo-France-Portal unter „Mes APIs → Générer Token“ die Option „API Key“ statt „OAuth2“ wählen. Den dauerhaft nutzbaren API-Key erzeugen und im Cloudflare-Push-Worker als **verschlüsseltes Secret `METEO_FRANCE_API_KEY`** speichern. Der Worker verwendet dann direkt den HTTP-Header `apikey` beim Abruf von `cartevigilance/encours` und **umgeht den Token-Endpunkt**. Die bisherige Basic/OAuth2-Methode bleibt erhalten, wird aber zurückgestellt, sobald `METEO_FRANCE_API_KEY` gesetzt ist. Schlüssel niemals hier im Chat oder in GitHub teilen. Voraussetzung: Météo-France hat das „Bulletin Vigilance“-Abonnement für dieselbe Anwendung aktiviert.

**Aktivierung der offiziellen Daten:** Auf https://portail-api.meteofrance.fr ein Konto erstellen und die kostenlose „API Bulletin Vigilance“ abonnieren. Im Portal aus dem OAuth2-Beispiel das persönliche Basic-Client-Credentials-Geheimnis (die Zeichenfolge hinter „Authorization: Basic“) entnehmen. Im Cloudflare-Push-Worker „argens-alerte-push“ unter Settings → Variables and Secrets ein verschlüsseltes Secret METEO_FRANCE_BASIC mit genau dieser Zeichenfolge ohne den Vorsatz „Basic “ hinzufügen und den Worker veröffentlichen. Niemals das Geheimnis in GitHub speichern. Der Worker erzeugt daraus selbst die zeitlich begrenzten Access-Tokens und fragt die offiziellen Daten ab.

**Regen:** Open-Meteo-Rückblick mit 3-/6-Stunden-Summen für drei repräsentative Standorte an Argens/Nartuby. WICHTIG: Das sind Modellschätzungen, keine tatsächlichen Radarmessungen oder Messungen für das ganze Einzugsgebiet. Die bereits vorhandene Windy-Radarkarte bleibt bestehen. Für echte automatisierte Radarmessungen wird zusätzlich ein Météo-France-Abonnement „API Données Radar“ und eine validierte Rasterverarbeitung benötigt; diese ist noch nicht aktiviert.

**Oberlieger-Pegel:** Hub’Eau-Messwerte von Carcès/Argens (Y511201001), Le Muy/Argens (Y530501501), Les Arcs/Aille (Y520201001), Trans-en-Provence/Pont des Écoles/Nartuby (Y523501002) und Vidauban/Endre (Y521502002). Alle fünf Stationen wurden bei einem unabhängigen Abruf am 15.11.2026 mit aktuellen Messwerten bestätigt. Angezeigt werden nur aktuelle Messwerte und lokale Steigungsraten; kein Vergleich absoluter Pegelhöhen zwischen verschiedenen Stationen und keine erfundene Ankunftszeit einer Welle.

**Sicherheit:** Diese Funktionen sind reine Zusatzinformationen. Individuelle Warnschwellen, Haupt-Push-Warnungen und Pegelfarben bleiben unverändert. Neue automatische Push-Frühwarnungen erst nach historischer Kalibrierung und Tests.

Tests: node --test push-worker/test/early-signals.test.mjs push-worker/test/water-sources.test.mjs
