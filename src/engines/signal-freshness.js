/**
 * Signal freshness engine.
 *
 * Context-aware signal staleness that goes beyond static exponential decay:
 * - Regime-aware acceleration: signals decay 3x faster in CHOP regimes
 * - Category-specific half-lives: crypto signals decay faster than politics
 * - Regime-change invalidation: signals from a different regime are stale
 * - Confirmation tracking: signals reinforced by later data stay fresher
 *
 * Produces a freshness score (0-1) where:
 * - 1.0 = perfectly fresh (just generated)
 * - 0.5 = half-life reached
 * - 0.0 = completely stale (should not trade)
 */

// Category-specific half-lives in minutes
const CATEGORY_HALFLIFE = {
  crypto: 4,
  Bitcoin: 4,
  Ethereum: 5,
  Sports: 8,
  Esports: 6,
  Tennis: 8,
  Politics: 20,
  Elections: 25,
  Economics: 30,
  Weather: 45,
  Science: 60,
  Entertainment: 15
};

const DEFAULT_HALFLIFE = 12; // minutes

// Regime decay multipliers (applied to half-life: lower = faster decay)
const REGIME_DECAY_MULT = {
  TREND_UP: 1.0,    // Normal decay in trends
  TREND_DOWN: 1.0,  // Normal decay in trends
  RANGE: 0.8,       // Slightly faster decay in range-bound
  CHOP: 0.33        // 3x faster decay in choppy markets
};

/**
 * Compute freshness score for a signal.
 *
 * @param {object} tick - Signal data with category, regime, side, confidence
 * @param {number} holdMinutes - How long since signal was generated
 * @param {object} opts
 * @param {string} opts.currentRegime - Current regime (for change detection)
 * @param {string} opts.signalRegime - Regime when signal was generated
 * @param {number} opts.confirmations - Number of confirming signals since generation
 * @returns {{ freshness, stale, halfLife, effectiveHalfLife, reason }}
 */
export function computeFreshness(tick, holdMinutes = 0, opts = {}) {
  const category = tick?.category || "unknown";
  const signalRegime = opts.signalRegime || tick?.regime || "RANGE";
  const currentRegime = opts.currentRegime || signalRegime;
  const confirmations = opts.confirmations || 0;

  // Base half-life from category
  const baseHalfLife = CATEGORY_HALFLIFE[category] ?? DEFAULT_HALFLIFE;

  // Regime multiplier
  const regimeMult = REGIME_DECAY_MULT[currentRegime] ?? 1.0;

  // Confirmation bonus: each confirmation extends effective half-life by 20%
  const confirmBonus = 1 + Math.min(confirmations, 5) * 0.2;

  // Effective half-life
  const effectiveHalfLife = baseHalfLife * regimeMult * confirmBonus;

  // Exponential decay: freshness = 0.5^(t / halfLife)
  let freshness = Math.pow(0.5, holdMinutes / effectiveHalfLife);

  // Regime change penalty: if regime changed since signal, apply harsh penalty
  let regimeChanged = false;
  if (signalRegime !== currentRegime) {
    regimeChanged = true;
    // Signals from different regimes lose 50% immediately
    freshness *= 0.5;
  }

  // Clamp to [0, 1]
  freshness = Math.max(0, Math.min(1, freshness));
  freshness = Math.round(freshness * 1000) / 1000;

  // Determine staleness
  const stale = freshness < 0.3;
  const halvings = holdMinutes / effectiveHalfLife;

  let reason = null;
  if (stale) {
    if (regimeChanged) reason = "regime_changed";
    else if (halvings >= 3) reason = "too_old";
    else reason = "decayed";
  }

  return {
    freshness,
    stale,
    halfLife: Math.round(baseHalfLife * 10) / 10,
    effectiveHalfLife: Math.round(effectiveHalfLife * 10) / 10,
    holdMinutes: Math.round(holdMinutes * 10) / 10,
    halvings: Math.round(halvings * 100) / 100,
    regimeChanged,
    confirmations,
    reason
  };
}

/**
 * Quick check: is this signal still fresh enough to trade?
 * @param {object} tick
 * @param {number} holdMinutes
 * @param {object} opts
 * @returns {boolean}
 */
export function isSignalFresh(tick, holdMinutes = 0, opts = {}) {
  const { stale } = computeFreshness(tick, holdMinutes, opts);
  return !stale;
}

/**
 * Get freshness profile: half-lives and decay curves for all categories.
 * @returns {{ categories: object[], regimeMultipliers: object, freshnessCutoff: number }}
 */
export function getFreshnessProfile() {
  const categories = Object.entries(CATEGORY_HALFLIFE).map(([cat, halfLife]) => {
    // Compute freshness at various hold durations
    const curve = [1, 2, 5, 10, 15, 30, 60].map(min => ({
      minutes: min,
      freshness: Math.round(Math.pow(0.5, min / halfLife) * 1000) / 1000
    }));

    // Time to staleness (freshness < 0.3)
    const staleAt = Math.round(halfLife * Math.log2(1 / 0.3) * 10) / 10;

    return {
      category: cat,
      halfLife,
      staleAt,
      curve
    };
  });

  categories.sort((a, b) => a.halfLife - b.halfLife);

  return {
    categories,
    regimeMultipliers: { ...REGIME_DECAY_MULT },
    freshnessCutoff: 0.3,
    confirmationBonus: "20% per confirmation (max 5)",
    regimeChangePenalty: "50% immediate reduction"
  };
}
