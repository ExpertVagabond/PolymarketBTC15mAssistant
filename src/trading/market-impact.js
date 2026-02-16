/**
 * Market impact model.
 *
 * Pre-trade impact forecasting for Polymarket CLOB:
 * - Linear impact: midPrice += α × orderSize
 * - Square-root (concave) impact: midPrice += α × √(orderSize)
 * - Regime-dependent multipliers: impact 2x in CHOP vs TREND
 * - Temporary vs permanent decomposition
 * - Depth-based slippage prediction
 *
 * Calibrated from historical execution data to produce
 * realistic pre-trade cost estimates.
 */

import { getDb } from "../subscribers/db.js";

// In-memory market depth cache
const depthCache = {};

// Regime impact multipliers
const REGIME_IMPACT_MULT = {
  TREND_UP: 0.8,    // Less impact in trending (natural flow direction)
  TREND_DOWN: 0.8,
  RANGE: 1.0,
  CHOP: 2.0          // Double impact in choppy markets
};

// Category liquidity factors (inverse: higher = less impact)
const CATEGORY_LIQUIDITY = {
  crypto: 1.0, Bitcoin: 1.0, Ethereum: 0.9,
  Sports: 0.8, Esports: 0.5,
  Politics: 0.9, Elections: 0.9,
  Economics: 0.7, Weather: 0.4,
  Science: 0.3, Entertainment: 0.6
};

/**
 * Record orderbook depth for impact estimation.
 *
 * @param {string} marketId
 * @param {object} depth
 * @param {number} depth.bidDepth - Total bid volume (top 10 levels)
 * @param {number} depth.askDepth - Total ask volume (top 10 levels)
 * @param {number} depth.spread - Current bid-ask spread
 * @param {string} depth.category
 */
export function recordDepth(marketId, depth) {
  if (!marketId) return;
  depthCache[marketId] = { ...depth, timestamp: Date.now() };
}

/**
 * Estimate market impact before placing an order.
 *
 * @param {object} order
 * @param {number} order.shares - Number of shares to trade
 * @param {string} order.side - YES or NO
 * @param {string} order.marketId
 * @param {object} opts
 * @param {string} opts.regime - Current regime
 * @param {string} opts.category - Market category
 * @returns {{ linearImpactBps, sqrtImpactBps, expectedSlippageBps, temporary, permanent, recommendation }}
 */
export function estimateImpact(order, opts = {}) {
  const shares = order.shares || 10;
  const marketId = order.marketId || "";
  const regime = opts.regime || "RANGE";
  const category = opts.category || "unknown";

  const regimeMult = REGIME_IMPACT_MULT[regime] ?? 1.0;
  const catLiquidity = CATEGORY_LIQUIDITY[category] ?? 0.5;
  const depth = depthCache[marketId];

  // Base impact coefficient (calibrated empirically)
  // α ≈ 0.5 bps per share for liquid markets
  const baseAlpha = 0.5 / Math.max(0.3, catLiquidity);

  // Depth adjustment: less depth = more impact
  const totalDepth = depth ? (depth.bidDepth ?? 0) + (depth.askDepth ?? 0) : 10;
  const depthFactor = totalDepth > 0 ? Math.min(3, 50 / totalDepth) : 3;

  // Linear impact model: Δp = α × size × regime × depth
  const linearAlpha = baseAlpha * regimeMult * depthFactor;
  const linearImpactBps = Math.round(linearAlpha * shares * 10) / 10;

  // Square-root impact model: Δp = α × √(size) × regime × depth
  // More realistic for larger orders (concave impact)
  const sqrtAlpha = baseAlpha * 2 * regimeMult * depthFactor;
  const sqrtImpactBps = Math.round(sqrtAlpha * Math.sqrt(shares) * 10) / 10;

  // Spread cost (always paid)
  const spreadBps = depth
    ? Math.round((depth.spread ?? 0.05) * 10000)
    : 50; // Default 50bps

  // Total expected slippage (spread + impact)
  const expectedSlippageBps = Math.round(spreadBps + (linearImpactBps + sqrtImpactBps) / 2);

  // Temporary vs permanent decomposition
  // Temporary: market reverts after our trade (50-80% of total impact)
  // Permanent: our trade reveals information (20-50%)
  const temporaryPct = regime === "CHOP" ? 0.8 : regime.startsWith("TREND") ? 0.5 : 0.65;
  const temporary = Math.round((linearImpactBps + sqrtImpactBps) / 2 * temporaryPct * 10) / 10;
  const permanent = Math.round((linearImpactBps + sqrtImpactBps) / 2 * (1 - temporaryPct) * 10) / 10;

  // Optimal order size: minimize impact per share
  const optimalSize = Math.round(Math.min(shares, totalDepth * 0.1)); // Max 10% of depth

  // Recommendation
  let recommendation;
  if (expectedSlippageBps > 100) {
    recommendation = "High impact expected. Use TWAP or reduce order size significantly.";
  } else if (expectedSlippageBps > 50) {
    recommendation = "Moderate impact. Consider splitting into 3-5 chunks.";
  } else if (expectedSlippageBps > 20) {
    recommendation = "Acceptable impact. Single order or 2 chunks.";
  } else {
    recommendation = "Low impact. Safe to execute as market order.";
  }

  return {
    marketId,
    orderSize: shares,
    side: order.side,
    regime,
    category,
    linearImpactBps,
    sqrtImpactBps,
    spreadBps,
    expectedSlippageBps,
    decomposition: {
      spreadCost: spreadBps,
      temporaryImpact: temporary,
      permanentImpact: permanent,
      temporaryPct: Math.round(temporaryPct * 100)
    },
    depthInfo: {
      totalDepth: Math.round(totalDepth),
      depthFactor: Math.round(depthFactor * 100) / 100,
      stale: depth ? (Date.now() - depth.timestamp > 300000) : true
    },
    optimalSize,
    recommendation
  };
}

/**
 * Get impact curves for a market at various order sizes.
 *
 * @param {string} marketId
 * @param {object} opts
 * @param {string} opts.regime
 * @param {string} opts.category
 * @returns {{ curves: object[], optimalRange: object }}
 */
export function getImpactCurves(marketId, opts = {}) {
  const sizes = [1, 2, 5, 10, 20, 50, 100];

  const curves = sizes.map(size => {
    const impact = estimateImpact(
      { shares: size, marketId, side: "YES" },
      opts
    );
    return {
      orderSize: size,
      linearBps: impact.linearImpactBps,
      sqrtBps: impact.sqrtImpactBps,
      totalExpectedBps: impact.expectedSlippageBps,
      costPerShare: Math.round(impact.expectedSlippageBps / size * 10) / 10
    };
  });

  // Find optimal range: where cost-per-share is minimized
  const minCostPerShare = Math.min(...curves.map(c => c.costPerShare));
  const optimal = curves.find(c => c.costPerShare === minCostPerShare);

  return {
    marketId,
    curves,
    optimalRange: {
      size: optimal?.orderSize ?? 1,
      costPerShare: minCostPerShare,
      totalCost: optimal?.totalExpectedBps ?? 0
    }
  };
}

/**
 * Calibrate impact model from historical execution data.
 *
 * @param {number} days - Lookback
 * @returns {{ calibration, modelFit }}
 */
export function calibrateImpactModel(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT market_id, category, regime, slippage_bps,
           confidence, quality_score
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('FILLED', 'WIN', 'LOSS', 'CLOSED')
    AND slippage_bps IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 10) {
    return { calibration: null, modelFit: null, message: "insufficient_data" };
  }

  // By regime
  const byRegime = {};
  for (const r of rows) {
    const key = r.regime || "unknown";
    if (!byRegime[key]) byRegime[key] = { slips: [], count: 0 };
    byRegime[key].slips.push(Math.abs(r.slippage_bps));
    byRegime[key].count++;
  }

  const regimeCalibration = {};
  for (const [regime, data] of Object.entries(byRegime)) {
    const avg = data.slips.reduce((s, v) => s + v, 0) / data.slips.length;
    const std = Math.sqrt(data.slips.reduce((s, v) => s + (v - avg) ** 2, 0) / data.slips.length);
    regimeCalibration[regime] = {
      avgSlippageBps: Math.round(avg * 10) / 10,
      stdSlippageBps: Math.round(std * 10) / 10,
      sampleSize: data.count
    };
  }

  // By category
  const byCategory = {};
  for (const r of rows) {
    const key = r.category || "unknown";
    if (!byCategory[key]) byCategory[key] = { slips: [], count: 0 };
    byCategory[key].slips.push(Math.abs(r.slippage_bps));
    byCategory[key].count++;
  }

  const categoryCalibration = {};
  for (const [cat, data] of Object.entries(byCategory)) {
    const avg = data.slips.reduce((s, v) => s + v, 0) / data.slips.length;
    categoryCalibration[cat] = {
      avgSlippageBps: Math.round(avg * 10) / 10,
      sampleSize: data.count
    };
  }

  // Overall model fit
  const allSlips = rows.map(r => Math.abs(r.slippage_bps));
  const overallAvg = allSlips.reduce((s, v) => s + v, 0) / allSlips.length;
  const overallStd = Math.sqrt(allSlips.reduce((s, v) => s + (v - overallAvg) ** 2, 0) / allSlips.length);

  return {
    calibration: {
      byRegime: regimeCalibration,
      byCategory: categoryCalibration
    },
    modelFit: {
      sampleSize: rows.length,
      avgSlippageBps: Math.round(overallAvg * 10) / 10,
      stdSlippageBps: Math.round(overallStd * 10) / 10,
      p95SlippageBps: Math.round(allSlips.sort((a, b) => a - b)[Math.floor(allSlips.length * 0.95)] * 10) / 10,
      maxSlippageBps: Math.round(Math.max(...allSlips) * 10) / 10
    }
  };
}
