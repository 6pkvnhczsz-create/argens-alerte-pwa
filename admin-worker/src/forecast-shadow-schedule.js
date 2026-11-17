// Explicit schedules for Cloudflare Cron Triggers on the admin Worker.
// Normal hourly sync imports 33 observation points; limit recovery to 22 requests
// so the normal scheduled batch stays under 55 total Météo-France requests.
// The three quarter-hour recovery-only triggers each permit at most 55 requests.
// No other trigger is allowed to launch data recovery unexpectedly.
export const NORMAL_CRON = '31 * * * *';
export const RECOVERY_CRON = '1,16,46 * * * *';
export function forecastCronPlan(cron) {
  if (cron === NORMAL_CRON) return {sync:true,backfillLimit:22};
  if (cron === RECOVERY_CRON) return {sync:false,backfillLimit:55};
  return {sync:false,backfillLimit:0};
}
