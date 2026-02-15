/**
 * Dynamic weight manager — learns from signal outcome history.
 *
 * Reads settled outcomes from the signal_history DB, computes win rates
 * per indicator state, and generates scoring weight adjustments.
 *
 * Falls back to default weights (1.0) when insufficient history (<50 settled).
 * Refreshes automatically every REFRESH_INTERVAL_MS.
 */

import { computeDynamicWeights, computeCategoryWeights, getFeatureWinRates, getComboWinRates } from "../signals/history.js";

const REFRESH_INTERVAL_MS = 10 * 60_000; // Recalculate every 10 minutes
const MIN_SETTLED = 50; // Minimum settled outcomes before learning kicks in

let cachedWeights = null;
let cachedCombos = null; // combo (pair) multipliers
let cachedCategoryWeights = null; // { category: { feature: { value: multiplier } } }
let lastRefreshMs = 0;
let refreshTimer = null;
let modelVersion = 0;
let weightHistory = []; // track weight changes for audit
const MAX_HISTORY = 50;

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
 * Tracks weight changes for audit trail.
 */
function refresh() {
  const prev = cachedWeights;
  try {
    const rawWeights = computeDynamicWeights();
    if (rawWeights) {
      cachedWeights = toMultipliers(rawWeights);
      modelVersion++;

      // Track significant changes
      if (prev) {
        const deltas = computeDeltas(prev, cachedWeights);
        if (deltas.length > 0) {
          weightHistory.push({
            version: modelVersion,
            timestamp: Date.now(),
            deltas
          });
          if (weightHistory.length > MAX_HISTORY) weightHistory.shift();
          console.log(`[weights] v${modelVersion}: ${deltas.length} weight(s) shifted`);
        }
      }
    } else {
      cachedWeights = null; // Not enough data, use defaults
    }

    // Refresh combo multipliers
    refreshCombos();

    // Refresh per-category weights
    refreshCategoryWeights();
  } catch {
    cachedWeights = null; // DB error, use defaults
    cachedCombos = null;
    cachedCategoryWeights = null;
  }
  lastRefreshMs = Date.now();
}

/**
 * Refresh combo (feature-pair) multipliers from history.
 * Combos with win rate significantly above/below 50% get a boost/dampen.
 */
function refreshCombos() {
  try {
    const combos = getComboWinRates(10);
    if (!combos || combos.length === 0) { cachedCombos = null; return; }

    const map = {};
    for (const c of combos) {
      if (c.win_rate == null) continue;
      // Convert win rate to multiplier: 50% → 1.0, 75% → 1.25, 25% → 0.75
      const confidenceFactor = Math.min(1, c.total / 30);
      const rawShift = ((c.win_rate / 100) - 0.5) * confidenceFactor;
      map[c.combo] = {
        multiplier: 1.0 + Math.max(-0.3, Math.min(0.3, rawShift)),
        winRate: c.win_rate,
        total: c.total,
        wins: c.wins
      };
    }
    cachedCombos = Object.keys(map).length > 0 ? map : null;
  } catch {
    cachedCombos = null;
  }
}

/**
 * Refresh per-category weight multipliers from history.
 * Each category gets its own weight table, falling back to global weights.
 */
function refreshCategoryWeights() {
  try {
    const raw = computeCategoryWeights(20);
    if (!raw) { cachedCategoryWeights = null; return; }

    const result = {};
    for (const [cat, catWeights] of Object.entries(raw)) {
      result[cat] = toMultipliers(catWeights);
    }
    cachedCategoryWeights = Object.keys(result).length > 0 ? result : null;
  } catch {
    cachedCategoryWeights = null;
  }
}

/**
 * Compute deltas between two weight snapshots.
 * Returns changes > 0.05 (5% shift).
 */
function computeDeltas(prev, next) {
  const deltas = [];
  for (const [feat, values] of Object.entries(next)) {
    if (!prev[feat]) continue;
    for (const [val, weight] of Object.entries(values)) {
      const prevWeight = prev[feat]?.[val];
      if (prevWeight != null && Math.abs(weight - prevWeight) > 0.05) {
        deltas.push({ feature: feat, value: val, from: prevWeight, to: weight, delta: weight - prevWeight });
      }
    }
  }
  return deltas;
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
 * Get the scoring weight for a specific indicator feature value, category-aware.
 * Tries category-specific weight first, falls back to global learned, then defaults.
 *
 * @param {string} feature - e.g. "rsi_zone"
 * @param {string} value - e.g. "OVERBOUGHT"
 * @param {string|null} category - e.g. "crypto", "Politics"
 * @returns {number} Multiplier (0.5 - 1.5, default 1.0)
 */
export function getCategoryWeight(feature, value, category) {
  if (Date.now() - lastRefreshMs > REFRESH_INTERVAL_MS) {
    refresh();
  }

  // Try category-specific weights first
  if (category && cachedCategoryWeights) {
    const catW = cachedCategoryWeights[category];
    if (catW && catW[feature] && catW[feature][value] != null) {
      return catW[feature][value];
    }
  }

  // Fall back to global weight
  return getWeight(feature, value);
}

/**
 * Get the combo (feature-pair) multiplier for a given VWAP+RSI combo.
 *
 * @param {string} vwapPosition - e.g. "ABOVE"
 * @param {string} rsiZone - e.g. "OVERBOUGHT"
 * @returns {number} Multiplier (0.7 - 1.3, default 1.0)
 */
export function getComboWeight(vwapPosition, rsiZone) {
  if (Date.now() - lastRefreshMs > REFRESH_INTERVAL_MS) {
    refresh();
  }
  if (!cachedCombos || !vwapPosition || !rsiZone) return 1.0;
  const key = vwapPosition + "+" + rsiZone;
  return cachedCombos[key]?.multiplier ?? 1.0;
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
    modelVersion,
    weights: cachedWeights || DEFAULT_WEIGHTS,
    combos: cachedCombos || {},
    categoryWeights: cachedCategoryWeights || {},
    categoryCount: cachedCategoryWeights ? Object.keys(cachedCategoryWeights).length : 0,
    lastRefresh: lastRefreshMs,
    nextRefresh: lastRefreshMs + REFRESH_INTERVAL_MS,
    recentChanges: weightHistory.slice(-10)
  };
}

/**
 * Get learning status for monitoring.
 */
export function getLearningStatus() {
  if (Date.now() - lastRefreshMs > REFRESH_INTERVAL_MS) {
    refresh();
  }
  return {
    active: cachedWeights !== null,
    modelVersion,
    source: cachedWeights ? "learned" : "default",
    lastRetrain: lastRefreshMs,
    nextRetrain: lastRefreshMs + REFRESH_INTERVAL_MS,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    minSettledRequired: MIN_SETTLED,
    recentChanges: weightHistory.slice(-5).map(h => ({
      version: h.version,
      timestamp: h.timestamp,
      changeCount: h.deltas.length,
      topChanges: h.deltas.slice(0, 3).map(d => `${d.feature}=${d.value}: ${d.from.toFixed(2)}→${d.to.toFixed(2)}`)
    }))
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
