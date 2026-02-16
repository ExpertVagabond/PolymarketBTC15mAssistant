/**
 * Market microstructure analyzer.
 *
 * Tracks orderbook quality metrics over time for each market:
 * - Spread stability: how much the bid-ask spread varies (lower = healthier)
 * - Depth persistence: how consistent orderbook depth is across snapshots
 * - Liquidity score: composite measure of tradability
 * - Toxic flow detection: when order flow systematically predicts adverse moves
 *
 * Uses in-memory ring buffers per market, fed by periodic scanner polls.
 */

const MAX_SNAPSHOTS = 60; // ~1 hour at 1/min polling
const marketBuffers = {};  // marketId -> { spreads[], depths[], imbalances[], timestamps[] }

/**
 * Record an orderbook snapshot for microstructure tracking.
 * Call this from the scanner on each poll cycle.
 *
 * @param {string} marketId
 * @param {{ spread: number, bidDepth: number, askDepth: number, pressureScore: number }} metrics
 */
export function recordMicroSnapshot(marketId, metrics) {
  if (!marketId || !metrics) return;

  if (!marketBuffers[marketId]) {
    marketBuffers[marketId] = {
      spreads: [],
      bidDepths: [],
      askDepths: [],
      imbalances: [],
      timestamps: []
    };
  }

  const buf = marketBuffers[marketId];
  buf.spreads.push(metrics.spread || 0);
  buf.bidDepths.push(metrics.bidDepth || 0);
  buf.askDepths.push(metrics.askDepth || 0);
  buf.imbalances.push(metrics.pressureScore || 0);
  buf.timestamps.push(Date.now());

  // Ring buffer trim
  if (buf.spreads.length > MAX_SNAPSHOTS) {
    buf.spreads.shift();
    buf.bidDepths.shift();
    buf.askDepths.shift();
    buf.imbalances.shift();
    buf.timestamps.shift();
  }
}

/**
 * Get microstructure analysis for a specific market.
 * @param {string} marketId
 * @returns {object|null}
 */
export function getMarketMicrostructure(marketId) {
  const buf = marketBuffers[marketId];
  if (!buf || buf.spreads.length < 3) return null;

  const n = buf.spreads.length;

  // Spread stability: coefficient of variation (lower = more stable)
  const avgSpread = mean(buf.spreads);
  const spreadStd = stddev(buf.spreads);
  const spreadCV = avgSpread > 0 ? spreadStd / avgSpread : 0;
  const spreadStability = Math.max(0, Math.round((1 - Math.min(spreadCV, 1)) * 100));

  // Depth persistence: how consistent total depth is
  const totalDepths = buf.bidDepths.map((b, i) => b + buf.askDepths[i]);
  const depthCV = mean(totalDepths) > 0 ? stddev(totalDepths) / mean(totalDepths) : 0;
  const depthPersistence = Math.max(0, Math.round((1 - Math.min(depthCV, 1)) * 100));

  // Depth imbalance trend: are imbalances consistently one-sided (toxic)?
  const recentImbalances = buf.imbalances.slice(-10);
  const avgImbalance = mean(recentImbalances);
  const imbalanceConsistency = recentImbalances.length >= 5
    ? recentImbalances.filter(i => Math.sign(i) === Math.sign(avgImbalance)).length / recentImbalances.length
    : 0;
  const toxicFlowScore = Math.round(imbalanceConsistency * Math.min(Math.abs(avgImbalance), 100));

  // Liquidity score: composite (0-100)
  const avgTotalDepth = mean(totalDepths);
  const depthScore = Math.min(100, Math.round(avgTotalDepth / 10)); // Normalize: $1000 depth = 100
  const liquidityScore = Math.round(
    spreadStability * 0.3 +
    depthPersistence * 0.3 +
    depthScore * 0.3 +
    (100 - toxicFlowScore) * 0.1
  );

  // Spread trend: expanding or tightening?
  const firstHalf = buf.spreads.slice(0, Math.floor(n / 2));
  const secondHalf = buf.spreads.slice(Math.floor(n / 2));
  const spreadTrend = mean(secondHalf) - mean(firstHalf);
  const spreadDirection = spreadTrend > 0.005 ? "widening" : spreadTrend < -0.005 ? "tightening" : "stable";

  return {
    marketId,
    snapshots: n,
    spread: {
      current: round4(buf.spreads[n - 1]),
      avg: round4(avgSpread),
      min: round4(Math.min(...buf.spreads)),
      max: round4(Math.max(...buf.spreads)),
      stability: spreadStability,
      trend: spreadDirection
    },
    depth: {
      avgBid: Math.round(mean(buf.bidDepths)),
      avgAsk: Math.round(mean(buf.askDepths)),
      avgTotal: Math.round(avgTotalDepth),
      persistence: depthPersistence
    },
    toxicFlow: {
      score: toxicFlowScore,
      direction: avgImbalance > 5 ? "buy_pressure" : avgImbalance < -5 ? "sell_pressure" : "balanced",
      consistency: Math.round(imbalanceConsistency * 100)
    },
    liquidityScore,
    quality: liquidityScore >= 70 ? "high" : liquidityScore >= 40 ? "medium" : "low"
  };
}

/**
 * Get microstructure stats across all tracked markets.
 * @returns {{ markets: object[], summary: object }}
 */
export function getMicrostructureStats() {
  const markets = [];

  for (const marketId of Object.keys(marketBuffers)) {
    const analysis = getMarketMicrostructure(marketId);
    if (analysis) markets.push(analysis);
  }

  markets.sort((a, b) => b.liquidityScore - a.liquidityScore);

  const scores = markets.map(m => m.liquidityScore);
  const avgLiquidity = scores.length > 0 ? Math.round(mean(scores)) : 0;
  const lowLiquidityCount = markets.filter(m => m.quality === "low").length;
  const toxicCount = markets.filter(m => m.toxicFlow.score > 50).length;

  return {
    markets: markets.slice(0, 20), // Top 20
    summary: {
      totalTracked: markets.length,
      avgLiquidityScore: avgLiquidity,
      lowLiquidityMarkets: lowLiquidityCount,
      toxicFlowMarkets: toxicCount,
      overallQuality: avgLiquidity >= 60 ? "healthy" : avgLiquidity >= 35 ? "fair" : "poor"
    }
  };
}

/**
 * Check if a market has acceptable microstructure for trading.
 * @param {string} marketId
 * @param {number} minScore - minimum liquidity score (default 30)
 * @returns {{ tradeable: boolean, score: number, reason: string|null }}
 */
export function isTradeable(marketId, minScore = 30) {
  const analysis = getMarketMicrostructure(marketId);
  if (!analysis) return { tradeable: true, score: null, reason: null }; // No data = allow

  if (analysis.liquidityScore < minScore) {
    return { tradeable: false, score: analysis.liquidityScore, reason: `low_liquidity (${analysis.liquidityScore}/${minScore})` };
  }
  if (analysis.toxicFlow.score > 70) {
    return { tradeable: false, score: analysis.liquidityScore, reason: `toxic_flow (score ${analysis.toxicFlow.score})` };
  }
  return { tradeable: true, score: analysis.liquidityScore, reason: null };
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function round4(n) { return Math.round(n * 10000) / 10000; }
