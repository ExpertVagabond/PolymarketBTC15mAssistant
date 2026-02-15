/**
 * @deprecated Legacy cooldown for Telegram/Discord alerts. See notifications/dispatch.js.
 * Default: 15 minutes (one full window).
 */

const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS) || 900_000;

const lastAlertMap = new Map();

export function canAlert(key) {
  const last = lastAlertMap.get(key);
  if (!last) return true;
  return Date.now() - last >= COOLDOWN_MS;
}

export function markAlerted(key) {
  lastAlertMap.set(key, Date.now());
}

export function resetCooldowns() {
  lastAlertMap.clear();
}
