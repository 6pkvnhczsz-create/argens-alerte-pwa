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
