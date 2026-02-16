/**
 * Signal decay engine.
 *
 * Models how signal confidence degrades over time based on indicator type:
 * - Fast-decay (RSI reversals, MACD crossovers): half-life ~5 minutes
 * - Medium-decay (Bollinger breakouts, volume spikes): half-life ~15 minutes
 * - Slow-decay (VWAP trend, macro alignment, regime): half-life ~60 minutes
 *
 * Also applies a time-to-settlement multiplier that penalizes signals
 * on markets approaching expiry (last 30 min = accelerating decay).
 *
 * Used for: re-evaluating held positions, deciding when to exit stale signals,
 * and adjusting confidence for signals that took a while to pass all gates.
 */

// Indicator half-lives in minutes
const INDICATOR_DECAY = {
  rsi:        { halfLife: 5,  category: "fast" },
  macd:       { halfLife: 5,  category: "fast" },
  stochastic: { halfLife: 8,  category: "fast" },
  bollinger:  { halfLife: 15, category: "medium" },
  volume:     { halfLife: 15, category: "medium" },
  orderFlow:  { halfLife: 10, category: "medium" },
  vwap:       { halfLife: 45, category: "slow" },
  regime:     { halfLife: 60, category: "slow" },
  macro:      { halfLife: 90, category: "slow" },
  btcCorr:    { halfLife: 60, category: "slow" }
};

/**
 * Compute the decay multiplier for a signal based on how long it's been held.
 *
 * @param {object} tick - Signal tick with indicator data
 * @param {number} holdDurationMin - How long the position has been held (minutes)
 * @param {object} opts - Optional: { settlementLeftMin }
 * @returns {{ multiplier: number, components: object, stale: boolean }}
 */
export function computeDecayMultiplier(tick, holdDurationMin = 0, opts = {}) {
  const components = {};
  let totalWeight = 0;
  let weightedDecay = 0;

  // Determine which indicators were active for this signal
  const activeIndicators = detectActiveIndicators(tick);

  for (const [name, config] of Object.entries(INDICATOR_DECAY)) {
    if (!activeIndicators.has(name)) continue;

    // Exponential decay: multiplier = 0.5^(t / halfLife)
    const decay = Math.pow(0.5, holdDurationMin / config.halfLife);
    const weight = config.category === "fast" ? 1 : config.category === "medium" ? 1.5 : 2;

    components[name] = {
      decay: Math.round(decay * 1000) / 1000,
      halfLife: config.halfLife,
      category: config.category
    };

    weightedDecay += decay * weight;
    totalWeight += weight;
  }

  // Composite decay multiplier (weighted average of active indicators)
  let multiplier = totalWeight > 0 ? weightedDecay / totalWeight : 1;

  // Time-to-settlement penalty
  const settlementLeftMin = opts.settlementLeftMin ?? tick.settlementLeftMin ?? null;
  let settlementPenalty = 1;
  if (settlementLeftMin != null && settlementLeftMin < 60) {
    // Accelerating penalty: 60min left = 0.95, 30min = 0.80, 15min = 0.50, 5min = 0.20
    settlementPenalty = Math.max(0.1, Math.min(1, settlementLeftMin / 60));
    multiplier *= settlementPenalty;
  }

  // Floor at 0.05 (never fully zero)
  multiplier = Math.max(0.05, Math.round(multiplier * 1000) / 1000);

  return {
    multiplier,
    stale: multiplier < 0.3,
    holdDurationMin,
    settlementPenalty: Math.round(settlementPenalty * 1000) / 1000,
    activeIndicators: [...activeIndicators],
    components
  };
}

/**
 * Detect which indicators contributed to a signal.
 * @param {object} tick
 * @returns {Set<string>}
 */
function detectActiveIndicators(tick) {
  const active = new Set();

  const scored = tick.scored;
  if (scored) {
    if (scored.rsi != null) active.add("rsi");
    if (scored.macd != null || scored.macdHist != null) active.add("macd");
    if (scored.stochastic != null || scored.stochK != null) active.add("stochastic");
    if (scored.bb != null || scored.bbPosition != null) active.add("bollinger");
    if (scored.volume != null || scored.volumeProfile != null) active.add("volume");
  }

  if (tick.orderFlow || tick.microHealth != null) active.add("orderFlow");
  if (tick.vwap != null || tick.indicators?.vwap != null) active.add("vwap");
  if (tick.regimeInfo || tick.regime) active.add("regime");
  if (tick.btcCorr != null || tick.correlation != null) active.add("btcCorr");
  if (tick.macroState != null) active.add("macro");

  // If we couldn't detect any, assume a standard set
  if (active.size === 0) {
    active.add("rsi").add("vwap").add("regime");
  }

  return active;
}

/**
 * Get decay curves for documentation/display.
 * Returns the expected multiplier at various hold durations for each category.
 */
export function getDecayCurves() {
  const timepoints = [0, 2, 5, 10, 15, 30, 45, 60, 90, 120];
  const curves = {};

  for (const category of ["fast", "medium", "slow"]) {
    const representative = Object.values(INDICATOR_DECAY).find(i => i.category === category);
    if (!representative) continue;

    curves[category] = {
      halfLife: representative.halfLife,
      points: timepoints.map(t => ({
        minutes: t,
        multiplier: Math.round(Math.pow(0.5, t / representative.halfLife) * 1000) / 1000
      }))
    };
  }

  return { curves, indicators: { ...INDICATOR_DECAY } };
}

/**
 * Check if a held position's signal has decayed below a threshold.
 * Useful for auto-exit decisions.
 *
 * @param {number} holdDurationMin - minutes held
 * @param {string} dominantCategory - "fast", "medium", or "slow"
 * @param {number} threshold - multiplier below which signal is considered stale (default 0.3)
 */
export function isSignalStale(holdDurationMin, dominantCategory = "medium", threshold = 0.3) {
  const halfLife = dominantCategory === "fast" ? 5 : dominantCategory === "medium" ? 15 : 60;
  const decay = Math.pow(0.5, holdDurationMin / halfLife);
  return { stale: decay < threshold, multiplier: Math.round(decay * 1000) / 1000, halfLife };
}
