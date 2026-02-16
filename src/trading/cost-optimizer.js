/**
 * Dynamic execution cost optimizer.
 *
 * Proactive fee and routing optimization:
 * - Algorithm selection: compares TWAP/VWAP/Iceberg/aggressive costs
 * - Maker vs taker routing based on spread and urgency
 * - Order splitting for minimal market impact
 * - Fee structure analysis from historical execution data
 * - Cost prediction before trade execution
 *
 * Feeds into order-algorithms.js execution decisions.
 */

import { getDb } from "../subscribers/db.js";

// Cost model parameters
const FEE_SCHEDULE = {
  taker: 0.0020,   // 20 bps taker fee
  maker: 0.0005,   // 5 bps maker fee (rebate possible)
  settlement: 0.0002 // 2 bps settlement
};

const ALGORITHM_PROFILES = {
  aggressive: { avgSlippageBps: 25, timeToFill: 1, makerPct: 0.0 },
  twap:       { avgSlippageBps: 12, timeToFill: 30, makerPct: 0.3 },
  vwap:       { avgSlippageBps: 10, timeToFill: 45, makerPct: 0.4 },
  iceberg:    { avgSlippageBps: 8, timeToFill: 60, makerPct: 0.6 },
  passive:    { avgSlippageBps: 3, timeToFill: 120, makerPct: 0.9 }
};

/**
 * Optimize execution cost for a target trade.
 *
 * @param {object} order
 * @param {number} order.shares
 * @param {number} order.price - Target price
 * @param {string} order.side - YES or NO
 * @param {string} order.marketId
 * @param {object} market
 * @param {number} market.spread - Current bid-ask spread
 * @param {number} market.volume24h - 24h volume
 * @param {number} market.depth - Orderbook depth at best level
 * @returns {{ algorithms, recommended, savings }}
 */
export function optimizeExecutionCost(order = {}, market = {}) {
  const shares = order.shares || 10;
  const price = order.price || 0.50;
  const notional = shares * price;
  const spread = market.spread || 0.02;
  const volume = market.volume24h || 1000;
  const depth = market.depth || 50;

  // Size impact: larger orders face more slippage
  const sizeRatio = shares / Math.max(depth, 1);
  const sizePenalty = Math.min(3.0, 1 + sizeRatio);

  // Evaluate each algorithm
  const algorithms = Object.entries(ALGORITHM_PROFILES).map(([name, profile]) => {
    const slippageBps = profile.avgSlippageBps * sizePenalty;
    const feeBps = profile.makerPct * FEE_SCHEDULE.maker * 10000
      + (1 - profile.makerPct) * FEE_SCHEDULE.taker * 10000
      + FEE_SCHEDULE.settlement * 10000;
    const totalCostBps = slippageBps + feeBps;
    const totalCostUsd = notional * totalCostBps / 10000;

    return {
      algorithm: name,
      slippageBps: round2(slippageBps),
      feeBps: round2(feeBps),
      totalCostBps: round2(totalCostBps),
      totalCostUsd: round2(totalCostUsd),
      makerPct: round3(profile.makerPct),
      estimatedFillTime: profile.timeToFill,
      fillTimeUnit: "seconds"
    };
  });

  algorithms.sort((a, b) => a.totalCostBps - b.totalCostBps);

  // Recommend based on urgency and cost
  const urgencyFactor = spread > 0.04 ? "high_spread" : sizeRatio > 0.5 ? "large_order" : "normal";
  let recommended;

  if (urgencyFactor === "high_spread") {
    recommended = algorithms.find(a => a.algorithm === "passive") || algorithms[0];
  } else if (urgencyFactor === "large_order") {
    recommended = algorithms.find(a => a.algorithm === "iceberg") || algorithms[0];
  } else {
    recommended = algorithms[0]; // cheapest
  }

  const worstCase = algorithms[algorithms.length - 1];
  const savings = round2(worstCase.totalCostUsd - recommended.totalCostUsd);

  return {
    algorithms,
    recommended: { ...recommended, reason: urgencyFactor },
    savings,
    savingsBps: round2(worstCase.totalCostBps - recommended.totalCostBps),
    orderContext: { shares, notional: round2(notional), sizeRatio: round3(sizeRatio), urgency: urgencyFactor }
  };
}

/**
 * Compute optimal order split for minimal impact.
 *
 * @param {number} targetShares
 * @param {object} opts
 * @param {number} opts.depth - Orderbook depth
 * @param {number} opts.maxSlices - Max order slices
 * @returns {{ slices, totalCostBps, spreadSavings }}
 */
export function computeOptimalSplit(targetShares, opts = {}) {
  const depth = opts.depth || 50;
  const maxSlices = Math.min(opts.maxSlices || 10, 20);

  if (targetShares <= depth * 0.5) {
    return {
      slices: [{ size: targetShares, pctOfTotal: 1.0, expectedSlippageBps: 5 }],
      totalSlices: 1,
      totalCostBps: 5,
      recommendation: "Single order — size within half of depth"
    };
  }

  // Split into chunks that each fit within depth
  const optimalChunk = Math.max(1, Math.floor(depth * 0.3));
  const numSlices = Math.min(maxSlices, Math.ceil(targetShares / optimalChunk));
  const sharePerSlice = Math.ceil(targetShares / numSlices);

  const slices = [];
  let remaining = targetShares;
  let cumulativeImpact = 0;

  for (let i = 0; i < numSlices; i++) {
    const size = Math.min(sharePerSlice, remaining);
    if (size <= 0) break;
    remaining -= size;

    // Impact grows with cumulative filled
    const fillRatio = (i * sharePerSlice) / depth;
    const slippageBps = 5 + fillRatio * 15;
    cumulativeImpact += slippageBps;

    slices.push({
      slice: i + 1,
      size,
      pctOfTotal: round3(size / targetShares),
      expectedSlippageBps: round2(slippageBps),
      delaySeconds: i * 15 // 15s between slices
    });
  }

  const avgCostBps = cumulativeImpact / slices.length;
  const singleOrderCostBps = 5 + (targetShares / depth) * 20;
  const spreadSavings = round2(singleOrderCostBps - avgCostBps);

  return {
    slices,
    totalSlices: slices.length,
    totalCostBps: round2(avgCostBps),
    singleOrderCostBps: round2(singleOrderCostBps),
    spreadSavings,
    recommendation: slices.length > 1
      ? `Split into ${slices.length} slices of ~${sharePerSlice} shares, ${spreadSavings} bps cheaper`
      : "No splitting needed"
  };
}

/**
 * Analyze historical execution costs by method.
 *
 * @param {number} days
 * @returns {{ byMethod, bestMethod, worstMethod, avgCostBps }}
 */
export function analyzeHistoricalCosts(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT sizing_method, regime,
           COUNT(*) as trades,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
           AVG(realized_pnl) as avg_pnl,
           SUM(realized_pnl) as total_pnl,
           AVG(confidence) as avg_conf,
           AVG(edge_at_entry) as avg_edge
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY sizing_method
    HAVING COUNT(*) >= 3
    ORDER BY AVG(realized_pnl) DESC
  `).all(daysOffset);

  if (rows.length === 0) {
    return { byMethod: [], bestMethod: null, worstMethod: null, avgCostBps: 0, message: "no_data" };
  }

  const byMethod = rows.map(r => ({
    method: r.sizing_method || "default",
    trades: r.trades,
    winRate: round3(r.wins / r.trades),
    avgPnl: round2(r.avg_pnl),
    totalPnl: round2(r.total_pnl),
    avgEdge: round3(r.avg_edge || 0),
    impliedCostBps: round2(Math.max(0, (r.avg_edge || 0) * 10000 - r.avg_pnl * 100))
  }));

  byMethod.sort((a, b) => a.impliedCostBps - b.impliedCostBps);

  return {
    byMethod,
    bestMethod: byMethod[0] || null,
    worstMethod: byMethod[byMethod.length - 1] || null,
    avgCostBps: round2(byMethod.reduce((s, m) => s + m.impliedCostBps, 0) / byMethod.length),
    lookbackDays: days
  };
}

/**
 * Get cost optimization dashboard.
 *
 * @returns {{ historicalCosts, sampleOptimization, recommendations }}
 */
export function getCostOptimizationDashboard() {
  const historical = analyzeHistoricalCosts();
  const sample = optimizeExecutionCost(
    { shares: 25, price: 0.55 },
    { spread: 0.02, volume24h: 5000, depth: 100 }
  );

  const recommendations = [];
  if (historical.bestMethod) {
    recommendations.push(`Best method: ${historical.bestMethod.method} (${historical.bestMethod.impliedCostBps} bps implied cost)`);
  }
  if (historical.worstMethod && historical.worstMethod.impliedCostBps > 20) {
    recommendations.push(`Avoid: ${historical.worstMethod.method} (${historical.worstMethod.impliedCostBps} bps — high cost)`);
  }
  if (sample.savingsBps > 5) {
    recommendations.push(`Smart routing saves ~${sample.savingsBps} bps vs aggressive execution`);
  }

  return {
    avgCostBps: historical.avgCostBps,
    methodCount: historical.byMethod.length,
    bestMethod: historical.bestMethod?.method || "unknown",
    worstMethod: historical.worstMethod?.method || "unknown",
    sampleSavingsBps: sample.savingsBps,
    recommendations
  };
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
