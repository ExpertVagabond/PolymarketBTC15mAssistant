/**
 * Order execution algorithms.
 *
 * Intelligent order splitting for thin Polymarket order books:
 * - TWAP: splits order into equal time-spaced chunks
 * - VWAP: adapts chunk sizes to historical volume profile
 * - Iceberg: hides total size, shows small visible quantity
 * - Adaptive: learns optimal chunk size from fill history
 *
 * Each algorithm produces an execution plan (list of child orders)
 * that the scanner-trader can execute sequentially.
 */

import { getDb } from "../subscribers/db.js";

// Default algorithm parameters
const DEFAULTS = {
  twap: { chunks: 5, intervalMs: 30000, randomJitter: 0.2 },
  vwap: { chunks: 5, lookbackMinutes: 60 },
  iceberg: { visiblePct: 0.20, minVisibleShares: 1 },
  adaptive: { minChunkSize: 1, maxChunkSize: 50 }
};

/**
 * Generate a TWAP execution plan.
 * Splits total order into equal-sized chunks spaced evenly over a time window.
 *
 * @param {object} order
 * @param {number} order.totalShares - Total shares to execute
 * @param {string} order.side - YES or NO
 * @param {string} order.marketId
 * @param {object} opts
 * @param {number} opts.chunks - Number of child orders
 * @param {number} opts.intervalMs - Time between chunks
 * @param {number} opts.randomJitter - Random delay variance (0-1)
 * @returns {{ algorithm, plan, summary }}
 */
export function planTWAP(order, opts = {}) {
  const chunks = opts.chunks || DEFAULTS.twap.chunks;
  const interval = opts.intervalMs || DEFAULTS.twap.intervalMs;
  const jitter = opts.randomJitter ?? DEFAULTS.twap.randomJitter;
  const total = order.totalShares || 10;
  const baseSize = Math.floor(total / chunks);
  const remainder = total - baseSize * chunks;

  const plan = [];
  for (let i = 0; i < chunks; i++) {
    const shares = baseSize + (i < remainder ? 1 : 0);
    if (shares <= 0) continue;

    const jitterMs = Math.round(interval * jitter * (Math.random() - 0.5));
    plan.push({
      sequence: i + 1,
      shares,
      side: order.side,
      marketId: order.marketId,
      delayMs: i * interval + jitterMs,
      scheduledAt: new Date(Date.now() + i * interval + jitterMs).toISOString()
    });
  }

  const totalDurationMs = (chunks - 1) * interval;

  return {
    algorithm: "TWAP",
    marketId: order.marketId,
    side: order.side,
    totalShares: total,
    plan,
    summary: {
      chunks: plan.length,
      avgChunkSize: baseSize,
      intervalMs: interval,
      totalDurationMs,
      totalDurationMin: Math.round(totalDurationMs / 60000 * 10) / 10,
      jitterPct: jitter
    }
  };
}

/**
 * Generate a VWAP execution plan.
 * Adapts chunk sizes proportional to historical volume profile.
 *
 * @param {object} order
 * @param {object} opts
 * @param {number} opts.chunks
 * @param {number} opts.lookbackMinutes
 * @returns {{ algorithm, plan, summary }}
 */
export function planVWAP(order, opts = {}) {
  const db = getDb();
  const chunks = opts.chunks || DEFAULTS.vwap.chunks;
  const lookback = opts.lookbackMinutes || DEFAULTS.vwap.lookbackMinutes;
  const total = order.totalShares || 10;

  // Get historical volume profile by time bucket
  const rows = db.prepare(`
    SELECT
      CAST((strftime('%M', created_at) / ?) AS INT) as bucket,
      COUNT(*) as trade_count
    FROM trade_executions
    WHERE market_id = ?
    AND created_at > datetime('now', ? || ' minutes')
    GROUP BY bucket
    ORDER BY bucket
  `).all(Math.ceil(lookback / chunks), order.marketId, -lookback);

  // Build volume weights
  let volumeWeights;
  if (rows.length >= 2) {
    const totalVol = rows.reduce((s, r) => s + r.trade_count, 0);
    volumeWeights = rows.map(r => r.trade_count / totalVol);
    // Pad to chunk count
    while (volumeWeights.length < chunks) volumeWeights.push(1 / chunks);
    volumeWeights = volumeWeights.slice(0, chunks);
  } else {
    // Fallback: U-shaped profile (more volume at open/close)
    volumeWeights = Array.from({ length: chunks }, (_, i) => {
      const pos = i / (chunks - 1 || 1);
      return 0.5 + 0.5 * Math.abs(pos - 0.5) * 2; // Higher at edges
    });
  }

  // Normalize weights
  const weightSum = volumeWeights.reduce((s, w) => s + w, 0);
  volumeWeights = volumeWeights.map(w => w / weightSum);

  const intervalMs = Math.round((lookback * 60000) / chunks);
  const plan = [];
  let allocated = 0;

  for (let i = 0; i < chunks; i++) {
    const shares = i === chunks - 1
      ? total - allocated
      : Math.max(1, Math.round(total * volumeWeights[i]));
    if (shares <= 0) continue;
    allocated += shares;

    plan.push({
      sequence: i + 1,
      shares: Math.min(shares, total - (allocated - shares)),
      side: order.side,
      marketId: order.marketId,
      volumeWeight: Math.round(volumeWeights[i] * 1000) / 1000,
      delayMs: i * intervalMs,
      scheduledAt: new Date(Date.now() + i * intervalMs).toISOString()
    });
  }

  return {
    algorithm: "VWAP",
    marketId: order.marketId,
    side: order.side,
    totalShares: total,
    plan,
    summary: {
      chunks: plan.length,
      intervalMs,
      totalDurationMin: Math.round(lookback * 10) / 10,
      volumeProfileSource: rows.length >= 2 ? "historical" : "synthetic_u_shape"
    }
  };
}

/**
 * Generate an Iceberg execution plan.
 * Shows only a visible portion; replenishes from hidden reserve.
 *
 * @param {object} order
 * @param {object} opts
 * @param {number} opts.visiblePct - Fraction visible (0-1)
 * @returns {{ algorithm, plan, summary }}
 */
export function planIceberg(order, opts = {}) {
  const visiblePct = opts.visiblePct || DEFAULTS.iceberg.visiblePct;
  const total = order.totalShares || 10;
  const visibleSize = Math.max(
    DEFAULTS.iceberg.minVisibleShares,
    Math.round(total * visiblePct)
  );

  const plan = [];
  let remaining = total;
  let seq = 0;

  while (remaining > 0) {
    seq++;
    const chunk = Math.min(visibleSize, remaining);
    plan.push({
      sequence: seq,
      shares: chunk,
      side: order.side,
      marketId: order.marketId,
      type: "iceberg_slice",
      hidden: remaining - chunk,
      delayMs: seq === 1 ? 0 : 5000 // 5s between replenishments
    });
    remaining -= chunk;
  }

  return {
    algorithm: "ICEBERG",
    marketId: order.marketId,
    side: order.side,
    totalShares: total,
    plan,
    summary: {
      slices: plan.length,
      visibleSize,
      hiddenSize: total - visibleSize,
      visiblePct: Math.round(visiblePct * 1000) / 1000,
      replenishDelayMs: 5000
    }
  };
}

/**
 * Get optimal execution strategy recommendation.
 * Analyzes market conditions to suggest the best algorithm.
 *
 * @param {object} order
 * @param {object} market - Market conditions
 * @param {number} market.spread
 * @param {number} market.volume24h
 * @param {number} market.bidDepth
 * @param {number} market.askDepth
 * @returns {{ recommended, reason, alternatives, plans }}
 */
export function recommendStrategy(order, market = {}) {
  const total = order.totalShares || 10;
  const spread = market.spread ?? 0.05;
  const volume = market.volume24h ?? 1000;
  const depth = (market.bidDepth ?? 0) + (market.askDepth ?? 0);

  // Decision logic
  let recommended;
  let reason;

  if (total <= 5) {
    // Small order — just market order
    recommended = "MARKET";
    reason = "Order is small enough for single execution";
  } else if (spread > 0.08 || depth < 10) {
    // Wide spread or thin book — TWAP to avoid impact
    recommended = "TWAP";
    reason = "Wide spread or thin orderbook — time-based splitting reduces impact";
  } else if (volume > 10000 && total > 20) {
    // High volume market with large order — VWAP to ride volume
    recommended = "VWAP";
    reason = "Liquid market — volume-weighted execution matches natural flow";
  } else if (total > 30) {
    // Large order — hide size
    recommended = "ICEBERG";
    reason = "Large order in moderate liquidity — hide total size";
  } else {
    recommended = "TWAP";
    reason = "Default: time-weighted splitting for moderate orders";
  }

  // Generate all plans for comparison
  const plans = {
    TWAP: planTWAP(order),
    VWAP: planVWAP(order),
    ICEBERG: planIceberg(order)
  };

  return {
    recommended,
    reason,
    orderSize: total,
    marketConditions: {
      spread: Math.round(spread * 10000) / 10000,
      volume24h: volume,
      depth: Math.round(depth),
      liquidity: depth > 50 ? "high" : depth > 10 ? "medium" : "low"
    },
    plans
  };
}

/**
 * Get execution algorithm performance from historical fills.
 *
 * @param {number} days - Lookback
 * @returns {{ byAlgorithm: object[], recommendation: string }}
 */
export function getAlgorithmPerformance(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT sizing_method, slippage_bps, realized_pnl, status
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS', 'CLOSED')
  `).all(daysOffset);

  const byMethod = {};
  for (const r of rows) {
    const method = r.sizing_method || "market";
    if (!byMethod[method]) byMethod[method] = { count: 0, wins: 0, totalSlip: 0, totalPnl: 0 };
    byMethod[method].count++;
    if (r.status === "WIN") byMethod[method].wins++;
    byMethod[method].totalSlip += Math.abs(r.slippage_bps ?? 0);
    byMethod[method].totalPnl += r.realized_pnl ?? 0;
  }

  const byAlgorithm = Object.entries(byMethod)
    .map(([method, d]) => ({
      method,
      trades: d.count,
      winRate: Math.round(d.wins / d.count * 1000) / 1000,
      avgSlippageBps: Math.round(d.totalSlip / d.count * 10) / 10,
      avgPnl: Math.round(d.totalPnl / d.count * 100) / 100
    }))
    .sort((a, b) => a.avgSlippageBps - b.avgSlippageBps);

  return {
    byAlgorithm,
    totalTrades: rows.length,
    recommendation: byAlgorithm.length > 1
      ? `Lowest slippage: ${byAlgorithm[0].method} (${byAlgorithm[0].avgSlippageBps} bps avg)`
      : "Insufficient data to compare algorithms"
  };
}
