# GitHub Actions → Cloudflare migration inventory (2026-11-19)

Status: planning only. No production workflows or alert paths have been disabled.

## Scheduled GitHub workflows confirmed

| Repository | Workflow | Cron | Migration |
|---|---|---|---|
| argens-alerte-pwa | vigicrues-backup-sync.yml | */5 * * * * | Replace scheduled GitHub OIDC snapshot ingestion with direct Cloudflare ingestion; preserve dynamic registered stations, retries, freshness checks, upstream coverage and storage. |
| argens-alerte-pwa | radar-map-sync.yml | */15 * * * * | Replace Python/HDF5/georeferencing pipeline only after verifying alternative reproduces measured 720x500 PNG and freshness. May need different compute service if Worker CPU/memory inadequate. |
| argens-alerte | publish-river-status.yml | */5 * * * * | Migrate consumers of river-status.json to Worker/D1 endpoint, preserve last-known-good observation and timestamp. |
| argens-hochwasserwarnung | rain.yml | 17 * * * * | Compare ntfy rain alert recipients, thresholds and cooldown with Cloudflare checkRainForecast; do not disable before equivalence verified. |
| cote-weekend-scout | scout.yml | 17 6,17 * * * | Separate travel project, low usage; defer. |

## Existing Cloudflare functions in deployed code supplied by user

- scheduled() calls scheduledCheck, checkRainForecast, checkPersonalStations and refreshEarlySignals.
- Worker Cron: every five minutes (confirmed from user Cloudflare dashboard).
- D1 DB binding: argens-alerte-db; independent SQL export completed by user.
- Existing Vigicrues backup endpoint /api/vigicrues-backup and signed GitHub OIDC ingestion /api/vigicrues-ingest.
- Radar signed OIDC ingestion and PNG output endpoints already exist.

## Safety gates before disabling each workflow

1. Preserve current code and D1 backup; do not commit secrets or personal data.
2. Verify upstream API access from Cloudflare, including failure cases and stale observations.
3. Build and test Cloudflare replacement on nonproduction branch/deployment.
4. Confirm live parity for station coverage, data freshness, push safety, duplicate suppression, monitoring and UI endpoints.
5. Only then remove scheduled trigger from corresponding GitHub workflow; retain manual rollback and tests.
6. Monitor replacement over several cycles and document restoration procedure.

## Notes

GitHub gross Actions usage is not equal to billable cost after discounts. Migration should prioritize reliability and avoid simply transferring cost to another provider. Cloudflare free/paid quotas and external API conditions require validation.

## 2026-11-19 implementation and test status

- Draft PR #84 contains opt-in Cloudflare Vigicrues cron code, D1 snapshot reuse, and safety tests. Production remains unchanged.
- GitHub Vigicrues regression checks: passing on commit b05ac23d. Translation checks: passing.
- Existing early-signal/radar checks failed on an outdated test expectation of refreshEarlySignals(env) without backupReader; test corrected in branch, latest CI rerun pending.
- Do not merge or activate VIGICRUES_CLOUDFLARE_SYNC until a real Cloudflare staging deployment confirms direct Vigicrues access, D1 persistence, and the alert behavior across several cycles.
- River-status.json publisher is consumed from separate argens-alerte repository; before disabling its 5-minute workflow, identify and migrate all consumers to a compatible Cloudflare status endpoint with last-known-good timestamps.
- Keep the 15-minute Python radar workflow unchanged per user decision.
