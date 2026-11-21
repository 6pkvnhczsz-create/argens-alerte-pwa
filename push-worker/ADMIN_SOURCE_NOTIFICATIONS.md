# Administrator-only data outage notifications

The scheduled push Worker evaluates the existing monitor_status record every five minutes.
When a successful reading or its observation timestamp is more than 60 minutes old, it sends one technical notification to the administrator. When both are fresh again, it sends one recovery notification. Transitions are persisted in D1 (admin_source_incident) only after a successful ntfy delivery, so failed deliveries are retried. A missing cron heartbeat (>30 minutes) is not misreported as a source outage; this requires an independent external heartbeat monitor.

## Opt-in configuration

Set BOTH Cloudflare Worker secrets on argens-alerte-push:
- ADMIN_NTFY_TOPIC: private ntfy topic identifier (8-128 alphanumeric, underscore or hyphen characters)
- ADMIN_NTFY_TOKEN: ntfy access token with permission to publish to that topic

Use an ntfy server/account supporting Bearer token authentication at https://ntfy.sh. Subscribe only the administrator's device to the private topic. Do not use the public Rivière Alerte subscriber topic or public push subscriptions.

Without both secrets the new notification path is disabled. No user-facing flood alert thresholds, subscription records, or push destinations are changed.

Operational limitation: A stopped Worker cron cannot notify through itself. Configure an external uptime/heartbeat monitor for the >30-minute scheduler outage separately.
