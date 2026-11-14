# Argens Alerte — independent Cloudflare push worker

This directory is **not** part of the GitHub Pages frontend deployment. It is a separate Cloudflare Worker, `argens-alerte-push`. The old Argens monitoring system and weather flight planner are unaffected.

## Already prepared in Cloudflare
- Worker `argens-alerte-push`
- D1 binding `DB` -> `argens-alerte-db`
- Secret `VAPID_PRIVATE_KEY` (32-byte P-256 private scalar encoded base64url, **never commit**)

## Still required
1. Add a plain-text runtime variable `VAPID_PUBLIC_KEY` with the public key from `wrangler.jsonc`.
2. Add a plain-text runtime variable `VAPID_SUBJECT` with a contact URL, for example `mailto:your-contact@example.com` (use your own address).
3. Deploy `src/index.js` to the existing Cloudflare Worker, either through its Edit Code UI or by Wrangler. Keep its existing D1 binding and secret.
4. Configure a Cloudflare Cron Trigger `*/5 * * * *` (every five minutes). A manual dashboard deployment may require setting the trigger separately in Settings > Trigger events.
5. Confirm `https://argens-alerte-push.p-hammerschmidt.workers.dev/health` returns JSON with `ok:true` and `pushConfigured:true`.
6. Only after backend is confirmed, set `PUSH_API_URL` in the PWA `index.html` to `https://argens-alerte-push.p-hammerschmidt.workers.dev`, and enable notification permission from the installed iOS Home Screen app.

## D1 schema
The existing database should have:

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 endpoint TEXT NOT NULL UNIQUE,
 subscription_json TEXT NOT NULL,
 station_code TEXT NOT NULL DEFAULT 'Y531201001',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS alert_state (
 station_code TEXT PRIMARY KEY,
 alert_level TEXT NOT NULL DEFAULT 'unknown',
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## Behavior
- Only station `Y531201001` (Roquebrune-sur-Argens).
- Green: below 3 m and rise below 30 cm/h.
- Orange: 3–4.5 m or rise at least 30 cm/h.
- Red: at least 4.5 m.
- Rise computed from readings 30–180 minutes apart.
- Stale measurements (older than 3 hours) do **not** trigger a notification.
- First scheduled check initializes current state without sending notifications.
- Notifications on transitions, including downward transitions.
- Expired subscriptions (HTTP 404/410) removed automatically.
- These are experimental, unofficial warning thresholds. Do not rely on them for personal safety.

## Important security/operational notes
- The `/subscribe` endpoint only accepts requests with the configured GitHub Pages Origin. Origin checks are not authentication. Before broad public rollout, add rate limiting, abuse prevention, subscription removal and privacy/retention disclosures.
- Push payloads use RFC 8291 aes128gcm Web Push encryption and VAPID authentication. Test end-to-end on a real iPhone before enabling for other users.
- The Worker stores push endpoint and encryption keys in D1. Handle as personal data under applicable privacy law.
- Do not put the VAPID private key in GitHub, a screenshot, or a chat.
- Worker and app code are prepared but not yet deployed or verified end-to-end.
