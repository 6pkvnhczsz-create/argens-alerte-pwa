// Data freshness is informational. It must never change flood thresholds or trigger flood alerts.
export const FRESHNESS_DELAYED_MS = 30 * 60 * 1000;
export const FRESHNESS_WARNING_MS = 60 * 60 * 1000;
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

/**
 * Stable, presentation-ready status independent of the flood alert decision.
 * Only the newest *actual* observation counts. Missing observations fail closed.
 */
export function observationDataStatus(result, {now = Date.now()} = {}) {
  const points = Array.isArray(result?.points) ? result.points : [];
  const newest = points.filter(p => Number.isFinite(p?.time))
    .reduce((best, p) => !best || p.time > best.time ? p : best, null);
  const freshness = classifyObservationFreshness(newest?.time, {now});
  return {
    ...freshness,
    source: typeof result?.source === 'string' ? result.source : null,
    transport: typeof result?.transport === 'string' ? result.transport : null,
    hasUsableReading: freshness.status !== 'unavailable' && Number.isFinite(newest?.mm),
  };
}

export const FRESHNESS_MESSAGES = Object.freeze({
  fr: Object.freeze({
    current: 'Mesure actuelle',
    delayed: 'Mesure retardée',
    warning: 'Attention : mesure de plus de 60 minutes',
    unavailable: 'Mesures indisponibles',
  }),
  en: Object.freeze({
    current: 'Current reading',
    delayed: 'Delayed reading',
    warning: 'Warning: reading older than 60 minutes',
    unavailable: 'Readings unavailable',
  }),
  de: Object.freeze({
    current: 'Aktueller Messwert',
    delayed: 'Verzögerter Messwert',
    warning: 'Datenwarnung: Messwert älter als 60 Minuten',
    unavailable: 'Messdaten nicht verfügbar',
  }),
});
