/**
 * Kalman filter signal fusion.
 *
 * State-space estimation for multi-timeframe signal blending:
 * - Hidden state: true market direction (continuous -1 to +1)
 * - Observations: discrete signals from 1m, 5m, 15m timeframes
 * - Process model: momentum with mean reversion
 * - Measurement model: noisy observations with timeframe-specific noise
 *
 * Produces an optimal blended signal with uncertainty bounds,
 * replacing the simple 0-3 confluence voting.
 *
 * Kalman equations:
 *   Predict: x̂ = F·x + B·u, P̂ = F·P·F' + Q
 *   Update:  K = P̂·H' / (H·P̂·H' + R), x = x̂ + K·(z - H·x̂), P = (I - K·H)·P̂
 */

// Per-market Kalman state
const filters = {};

// Timeframe configurations
const TIMEFRAME_CONFIG = {
  "1m":  { noiseVar: 0.15, weight: 0.2, lagMs: 5000 },
  "5m":  { noiseVar: 0.08, weight: 0.35, lagMs: 15000 },
  "15m": { noiseVar: 0.04, weight: 0.45, lagMs: 45000 }
};

// Regime-adaptive noise scaling
const REGIME_NOISE_MULT = {
  TREND_UP: 0.7,    // Less noise in trends — trust signals more
  TREND_DOWN: 0.7,
  RANGE: 1.0,
  CHOP: 1.8          // Much more noise in chop — trust less
};

/**
 * Initialize or get Kalman filter for a market.
 *
 * @param {string} marketId
 * @returns {object} Filter state
 */
function getFilter(marketId) {
  if (!filters[marketId]) {
    filters[marketId] = {
      x: 0,          // State estimate (direction: -1 to +1)
      P: 1.0,        // Estimate uncertainty
      lastUpdate: 0,
      observations: [],
      history: []     // Last 30 state estimates for trend
    };
  }
  return filters[marketId];
}

/**
 * Feed an observation from a specific timeframe.
 *
 * @param {string} marketId
 * @param {string} timeframe - "1m", "5m", or "15m"
 * @param {number} signal - Observed signal direction (-1 to +1)
 * @param {object} opts
 * @param {string} opts.regime - Current regime for noise adjustment
 * @returns {{ state, uncertainty, confidence }}
 */
export function observeSignal(marketId, timeframe, signal, opts = {}) {
  const kf = getFilter(marketId);
  const tf = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG["5m"];
  const regime = opts.regime || "RANGE";
  const noiseMult = REGIME_NOISE_MULT[regime] ?? 1.0;

  // Time delta for process noise
  const now = Date.now();
  const dt = kf.lastUpdate > 0 ? (now - kf.lastUpdate) / 60000 : 1; // minutes
  kf.lastUpdate = now;

  // --- PREDICT STEP ---
  // Process model: x_new = α·x_old (momentum with mean reversion)
  const alpha = 0.95; // Slight mean reversion
  const F = alpha;
  const Q = 0.02 * dt * noiseMult; // Process noise scales with time and regime

  const xPred = F * kf.x;
  const PPred = F * kf.P * F + Q;

  // --- UPDATE STEP ---
  const H = 1; // Direct observation of state
  const R = tf.noiseVar * noiseMult; // Measurement noise (regime-adjusted)

  // Kalman gain
  const S = H * PPred * H + R;
  const K = PPred * H / S;

  // State update
  kf.x = xPred + K * (signal - H * xPred);
  kf.P = (1 - K * H) * PPred;

  // Clamp state to [-1, 1]
  kf.x = Math.max(-1, Math.min(1, kf.x));

  // Record observation
  kf.observations.push({
    timeframe,
    signal: Math.round(signal * 1000) / 1000,
    kalmanGain: Math.round(K * 1000) / 1000,
    timestamp: now
  });
  if (kf.observations.length > 30) kf.observations = kf.observations.slice(-30);

  // History for trend tracking
  kf.history.push({ x: Math.round(kf.x * 1000) / 1000, P: Math.round(kf.P * 1000) / 1000, t: now });
  if (kf.history.length > 30) kf.history = kf.history.slice(-30);

  return {
    state: Math.round(kf.x * 1000) / 1000,
    uncertainty: Math.round(kf.P * 1000) / 1000,
    kalmanGain: Math.round(K * 1000) / 1000,
    confidence: uncertaintyToConfidence(kf.P)
  };
}

/**
 * Get fused signal for a market (read current state without new observation).
 *
 * @param {string} marketId
 * @returns {{ signal, direction, confidence, uncertainty, trend, observations }|null}
 */
export function getFusedSignal(marketId) {
  const kf = filters[marketId];
  if (!kf || kf.history.length < 2) return null;

  const state = kf.x;
  const uncertainty = kf.P;
  const confidence = uncertaintyToConfidence(uncertainty);

  // Compute trend from recent history
  const recent = kf.history.slice(-10);
  const oldState = recent[0].x;
  const trend = state - oldState;

  // Direction classification
  const direction = state > 0.15 ? "bullish"
    : state < -0.15 ? "bearish"
    : "neutral";

  // Signal strength (0-1)
  const strength = Math.min(1, Math.abs(state));

  return {
    marketId,
    signal: Math.round(state * 1000) / 1000,
    direction,
    strength: Math.round(strength * 1000) / 1000,
    confidence,
    uncertainty: Math.round(uncertainty * 1000) / 1000,
    trend: Math.round(trend * 1000) / 1000,
    trendDirection: trend > 0.05 ? "strengthening" : trend < -0.05 ? "weakening" : "stable",
    recentObservations: kf.observations.slice(-5),
    stateHistory: kf.history.slice(-10)
  };
}

/**
 * Get fusion overview across all markets.
 *
 * @returns {{ markets: object[], summary: object }}
 */
export function getFusionOverview() {
  const results = [];

  for (const marketId of Object.keys(filters)) {
    const signal = getFusedSignal(marketId);
    if (signal) results.push(signal);
  }

  if (results.length === 0) {
    return { markets: [], summary: { count: 0, avgConfidence: 0 } };
  }

  results.sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal));

  const avgConf = results.reduce((s, r) => s + parseFloat(r.confidence), 0) / results.length;
  const bullish = results.filter(r => r.direction === "bullish").length;
  const bearish = results.filter(r => r.direction === "bearish").length;
  const neutral = results.filter(r => r.direction === "neutral").length;

  return {
    markets: results.slice(0, 20),
    summary: {
      count: results.length,
      avgConfidence: Math.round(avgConf * 1000) / 1000,
      bullish,
      bearish,
      neutral,
      netDirection: bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "mixed",
      strongSignals: results.filter(r => r.strength > 0.5).length
    }
  };
}

/**
 * Get Kalman filter diagnostics.
 *
 * @returns {{ filterCount, avgUncertainty, regimeNoiseMultipliers, timeframeConfig }}
 */
export function getFilterDiagnostics() {
  const activeFilters = Object.keys(filters).length;
  const uncertainties = Object.values(filters).map(f => f.P);
  const avgP = uncertainties.length > 0
    ? uncertainties.reduce((s, v) => s + v, 0) / uncertainties.length : 0;

  return {
    filterCount: activeFilters,
    avgUncertainty: Math.round(avgP * 1000) / 1000,
    avgConfidence: uncertaintyToConfidence(avgP),
    regimeNoiseMultipliers: { ...REGIME_NOISE_MULT },
    timeframeConfig: Object.fromEntries(
      Object.entries(TIMEFRAME_CONFIG).map(([tf, c]) => [tf, {
        noiseVariance: c.noiseVar,
        weight: c.weight,
        lagMs: c.lagMs
      }])
    ),
    processModel: {
      alpha: 0.95,
      description: "Momentum with mean reversion"
    }
  };
}

// Convert uncertainty to human-readable confidence
function uncertaintyToConfidence(P) {
  if (P < 0.1) return "very_high";
  if (P < 0.3) return "high";
  if (P < 0.6) return "medium";
  if (P < 1.0) return "low";
  return "very_low";
}
