/**
 * Dynamic weight manager — learns from signal outcome history.
 *
 * Reads settled outcomes from the signal_history DB, computes win rates
 * per indicator state, and generates scoring weight adjustments.
 *
 * Falls back to default weights (1.0) when insufficient history (<50 settled).
 * Refreshes automatically every REFRESH_INTERVAL_MS.
 */

import { computeDynamicWeights, getFeatureWinRates } from "../signals/history.js";

const REFRESH_INTERVAL_MS = 10 * 60_000; // Recalculate every 10 minutes
const MIN_SETTLED = 50; // Minimum settled outcomes before learning kicks in

let cachedWeights = null;
let lastRefreshMs = 0;
let refreshTimer = null;

/**
 * Default indicator weights (used when insufficient history).
 * Maps feature values to scoring adjustments.
 * 1.0 = no adjustment, >1.0 = boost, <1.0 = dampen, 0 = skip.
 */
const DEFAULT_WEIGHTS = {
  vwap_position: { ABOVE: 1.0, BELOW: 1.0, AT: 1.0 },
  vwap_slope_dir: { UP: 1.0, DOWN: 1.0, FLAT: 1.0 },
  rsi_zone: { OVERBOUGHT: 1.0, BULLISH: 1.0, NEUTRAL: 1.0, BEARISH: 1.0, OVERSOLD: 1.0 },
  macd_state: { EXPANDING_GREEN: 1.0, FADING_GREEN: 1.0, EXPANDING_RED: 1.0, FADING_RED: 1.0, ZERO: 1.0 },
  heiken_color: { green: 1.0, red: 1.0 },
  ob_zone: { STRONG_BID: 1.0, BID: 1.0, BALANCED: 1.0, ASK: 1.0, STRONG_ASK: 1.0 },
  vol_regime: { LOW_VOL: 1.0, NORMAL_VOL: 1.0, HIGH_VOL: 1.0 },
  regime: { TREND_UP: 1.0, TREND_DOWN: 1.0, RANGE: 1.0, CHOP: 1.0 }
};

/**
 * Convert raw dynamic weights (-1 to +1) into scoring multipliers (0.5 to 1.5).
 * Raw weight: -1 = always loses, 0 = coin flip, +1 = always wins
 * Multiplier: 0.5 = halve the score, 1.0 = neutral, 1.5 = 50% boost
 */
function toMultipliers(rawWeights) {
  if (!rawWeights) return null;

  const multipliers = {};
  for (const [feat, values] of Object.entries(rawWeights)) {
    multipliers[feat] = {};
    for (const [val, rawWeight] of Object.entries(values)) {
      // Clamp raw weight to [-0.5, 0.5] then shift to [0.5, 1.5]
      const clamped = Math.max(-0.5, Math.min(0.5, rawWeight));
      multipliers[feat][val] = 1.0 + clamped;
    }
  }
  return multipliers;
}

/**
 * Refresh weights from the signal history DB.
 */
function refresh() {
  try {
    const rawWeights = computeDynamicWeights();
    if (rawWeights) {
      cachedWeights = toMultipliers(rawWeights);
    } else {
      cachedWeights = null; // Not enough data, use defaults
    }
  } catch {
    cachedWeights = null; // DB error, use defaults
  }
  lastRefreshMs = Date.now();
}

/**
 * Get the current scoring weight for a specific indicator feature value.
 *
 * @param {string} feature - e.g. "rsi_zone"
 * @param {string} value - e.g. "OVERBOUGHT"
 * @returns {number} Multiplier (0.5 - 1.5, default 1.0)
 */
export function getWeight(feature, value) {
  // Auto-refresh if stale
  if (Date.now() - lastRefreshMs > REFRESH_INTERVAL_MS) {
    refresh();
  }

  // Try learned weights first
  if (cachedWeights && cachedWeights[feature] && cachedWeights[feature][value] != null) {
    return cachedWeights[feature][value];
  }

  // Fall back to defaults
  if (DEFAULT_WEIGHTS[feature] && DEFAULT_WEIGHTS[feature][value] != null) {
    return DEFAULT_WEIGHTS[feature][value];
  }

  return 1.0;
}

/**
 * Get all current weights (for dashboard/debugging).
 */
export function getAllWeights() {
  if (Date.now() - lastRefreshMs > REFRESH_INTERVAL_MS) {
    refresh();
  }
  return {
    source: cachedWeights ? "learned" : "default",
    weights: cachedWeights || DEFAULT_WEIGHTS,
    lastRefresh: lastRefreshMs,
    nextRefresh: lastRefreshMs + REFRESH_INTERVAL_MS
  };
}

/**
 * Start periodic weight refresh.
 */
export function startWeightRefresh() {
  refresh(); // Initial load
  refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
}

/**
 * Stop periodic weight refresh.
 */
export function stopWeightRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
