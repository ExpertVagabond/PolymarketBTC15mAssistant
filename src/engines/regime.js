// Per-market regime history for transition tracking
const regimeHistory = new Map(); // marketId -> { current, since, transitions[] }

export function detectRegime({ price, vwap, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg }) {
  if (price === null || vwap === null || vwapSlope === null) return { regime: "CHOP", reason: "missing_inputs", stability: 0 };

  const above = price > vwap;
  let regime, reason;

  const lowVolume = volumeRecent !== null && volumeAvg !== null ? volumeRecent < 0.6 * volumeAvg : false;
  if (lowVolume && Math.abs((price - vwap) / vwap) < 0.001) {
    regime = "CHOP"; reason = "low_volume_flat";
  } else if (above && vwapSlope > 0) {
    regime = "TREND_UP"; reason = "price_above_vwap_slope_up";
  } else if (!above && vwapSlope < 0) {
    regime = "TREND_DOWN"; reason = "price_below_vwap_slope_down";
  } else if (vwapCrossCount !== null && vwapCrossCount >= 3) {
    regime = "RANGE"; reason = "frequent_vwap_cross";
  } else {
    regime = "RANGE"; reason = "default";
  }

  return { regime, reason, stability: 0 };
}

/**
 * Detect regime with transition tracking for a specific market.
 * Returns regime + stability score (0-100, higher = more stable).
 */
export function detectRegimeWithTracking(marketId, inputs) {
  const result = detectRegime(inputs);

  let history = regimeHistory.get(marketId);
  if (!history) {
    history = { current: result.regime, since: Date.now(), transitions: [] };
    regimeHistory.set(marketId, history);
  }

  if (result.regime !== history.current) {
    history.transitions.push({
      from: history.current,
      to: result.regime,
      timestamp: Date.now(),
      duration: Date.now() - history.since
    });
    // Keep last 20 transitions per market
    if (history.transitions.length > 20) history.transitions.shift();
    history.current = result.regime;
    history.since = Date.now();
  }

  // Stability: how long current regime has held (capped at 100)
  const holdMinutes = (Date.now() - history.since) / 60_000;
  // 30+ minutes at same regime = full stability
  const stability = Math.min(100, Math.round((holdMinutes / 30) * 100));

  // Transition rate: transitions in last 60 minutes (high = unstable)
  const recentCutoff = Date.now() - 60 * 60_000;
  const recentTransitions = history.transitions.filter(t => t.timestamp > recentCutoff).length;

  result.stability = Math.max(0, stability - recentTransitions * 15);
  result.holdMinutes = Math.round(holdMinutes * 10) / 10;
  result.recentTransitions = recentTransitions;

  return result;
}

/**
 * Get regime history for all tracked markets.
 */
export function getRegimeTransitions() {
  const result = [];
  for (const [marketId, history] of regimeHistory) {
    result.push({
      marketId,
      current: history.current,
      holdMinutes: Math.round((Date.now() - history.since) / 60_000 * 10) / 10,
      transitions: history.transitions.slice(-10)
    });
  }
  return result;
}

/**
 * Get aggregate regime distribution across all tracked markets.
 */
export function getRegimeDistribution() {
  const dist = { TREND_UP: 0, TREND_DOWN: 0, RANGE: 0, CHOP: 0 };
  for (const history of regimeHistory.values()) {
    dist[history.current] = (dist[history.current] || 0) + 1;
  }
  const total = regimeHistory.size || 1;
  return {
    total,
    distribution: Object.entries(dist).map(([regime, count]) => ({
      regime, count, pct: Math.round((count / total) * 100)
    }))
  };
}
