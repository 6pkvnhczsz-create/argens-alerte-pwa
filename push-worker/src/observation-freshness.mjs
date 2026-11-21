// Data freshness is informational. It must never change flood thresholds or trigger flood alerts.
export const FRESHNESS_DELAYED_MS = 15 * 60 * 1000;
export const FRESHNESS_WARNING_MS = 30 * 60 * 1000;
export const FRESHNESS_FUTURE_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * Evaluate the timestamp of the actual hydrological observation, not the
 * snapshot receipt or API response time. No water level is fabricated.
 */
export function classifyObservationFreshness(observedAt, {now = Date.now()} = {}) {
  const timestamp = typeof observedAt === 'number'
    ? observedAt
    : typeof observedAt === 'string' && observedAt.trim()
      ? Date.parse(observedAt)
      : NaN;
  if (!Number.isFinite(timestamp) || timestamp > now + FRESHNESS_FUTURE_TOLERANCE_MS) {
    return {status: 'unavailable', ageMinutes: null, observedAt: null};
  }
  const ageMs = Math.max(0, now - timestamp);
  const status = ageMs > FRESHNESS_WARNING_MS ? 'warning'
    : ageMs > FRESHNESS_DELAYED_MS ? 'delayed' : 'current';
  return {status, ageMinutes: Math.floor(ageMs / 60000),
    observedAt: new Date(timestamp).toISOString()};
}
