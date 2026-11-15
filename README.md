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
