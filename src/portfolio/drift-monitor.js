/**
 * Portfolio drift monitor & rebalancing automation.
 *
 * Continuously tracks allocation deviation from targets:
 * - Real-time drift scoring per category and market
 * - Threshold-crossing alerts with urgency levels
 * - Rebalancing cost decomposition (spread + slippage + impact)
 * - Cost-benefit ROI evaluation: rebalance now vs wait
 * - Optimal rebalancing trade suggestions
 *
 * Enforces portfolio optimization decisions from optimizer.js.
 */

import { getDb } from "../subscribers/db.js";

// Target allocation defaults (overridden by optimizer output)
const DEFAULT_TARGETS = {
  crypto: 0.40,
  politics: 0.20,
  sports: 0.15,
  science: 0.10,
  other: 0.15
};

const DRIFT_THRESHOLDS = {
  minor: 0.05,    // 5% drift — monitor
  moderate: 0.10, // 10% drift — consider rebalancing
  severe: 0.15,   // 15% drift — rebalance recommended
  critical: 0.25  // 25% drift — urgent rebalance
};

/**
 * Track current portfolio drift from target allocations.
 *
 * @param {object} opts
 * @param {object} opts.targets - Category → target weight (default: DEFAULT_TARGETS)
 * @param {number} opts.days - Lookback for current allocations
 * @returns {{ driftByCategory, driftScore, exceedances, rebalanceNeeded }}
 */
export function trackPortfolioDrift(opts = {}) {
  const db = getDb();
  const targets = opts.targets || DEFAULT_TARGETS;
  const days = Math.min(opts.days || 7, 90);
  const daysOffset = `-${days} days`;

  // Get current exposure by category
  const rows = db.prepare(`
    SELECT category,
           COUNT(*) as trades,
           SUM(ABS(realized_pnl)) as exposure,
           SUM(realized_pnl) as net_pnl,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY category
  `).all(daysOffset);

  if (rows.length === 0) {
    return { driftByCategory: {}, driftScore: 0, exceedances: [], rebalanceNeeded: false, message: "no_data" };
  }

  const totalExposure = rows.reduce((s, r) => s + r.exposure, 0) || 1;

  // Compute drift per category
  const driftByCategory = {};
  const exceedances = [];

  for (const [cat, target] of Object.entries(targets)) {
    const row = rows.find(r => (r.category || "other") === cat);
    const actual = row ? row.exposure / totalExposure : 0;
    const drift = actual - target;
    const absDrift = Math.abs(drift);

    let severity = "normal";
    if (absDrift >= DRIFT_THRESHOLDS.critical) severity = "critical";
    else if (absDrift >= DRIFT_THRESHOLDS.severe) severity = "severe";
    else if (absDrift >= DRIFT_THRESHOLDS.moderate) severity = "moderate";
    else if (absDrift >= DRIFT_THRESHOLDS.minor) severity = "minor";

    driftByCategory[cat] = {
      target: round3(target),
      actual: round3(actual),
      drift: round3(drift),
      absDrift: round3(absDrift),
      severity,
      trades: row?.trades || 0,
      direction: drift > 0 ? "overweight" : drift < 0 ? "underweight" : "on_target"
    };

    if (severity !== "normal") {
      exceedances.push({ category: cat, drift: round3(drift), severity });
    }
  }

  // Handle categories in data but not in targets
  for (const r of rows) {
    const cat = r.category || "other";
    if (!driftByCategory[cat]) {
      const actual = r.exposure / totalExposure;
      driftByCategory[cat] = {
        target: 0,
        actual: round3(actual),
        drift: round3(actual),
        absDrift: round3(actual),
        severity: actual > DRIFT_THRESHOLDS.moderate ? "moderate" : "minor",
        trades: r.trades,
        direction: "untracked"
      };
    }
  }

  // Composite drift score (0-100, weighted by severity)
  const totalDrift = Object.values(driftByCategory).reduce((s, d) => s + d.absDrift, 0);
  const driftScore = Math.min(100, Math.round(totalDrift / Object.keys(targets).length * 500));

  const rebalanceNeeded = exceedances.some(e => e.severity === "severe" || e.severity === "critical");

  return {
    driftByCategory,
    driftScore,
    exceedances: exceedances.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift)),
    rebalanceNeeded,
    totalExposure: round2(totalExposure),
    lookbackDays: days
  };
}

/**
 * Estimate rebalancing cost for suggested trades.
 *
 * @param {number} days
 * @returns {{ trades, totalCostBps, breakdown }}
 */
export function estimateRebalancingCost(days = 7) {
  const drift = trackPortfolioDrift({ days });
  if (!drift.rebalanceNeeded && drift.exceedances.length === 0) {
    return { trades: [], totalCostBps: 0, message: "no_rebalancing_needed" };
  }

  const db = getDb();
  const daysOffset = `-${Math.min(days, 90)} days`;

  // Get average slippage from recent executions
  const slippageRow = db.prepare(`
    SELECT AVG(ABS(realized_pnl)) as avg_trade_size,
           COUNT(*) as trade_count
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
  `).get(daysOffset);

  const avgTradeSize = slippageRow?.avg_trade_size || 1;
  const baseCostBps = 15; // ~15 bps typical Polymarket cost

  // Generate rebalancing trade suggestions
  const trades = [];
  for (const exc of drift.exceedances) {
    const d = drift.driftByCategory[exc.category];
    if (!d) continue;

    const rebalanceAmount = round2(Math.abs(d.drift) * drift.totalExposure);
    const estimatedSlippage = round2(rebalanceAmount * baseCostBps / 10000);

    trades.push({
      category: exc.category,
      action: d.direction === "overweight" ? "reduce" : "increase",
      targetDelta: round3(d.drift),
      estimatedAmount: rebalanceAmount,
      estimatedCostBps: baseCostBps,
      estimatedSlippage,
      priority: d.severity === "critical" ? "immediate" : d.severity === "severe" ? "high" : "medium"
    });
  }

  trades.sort((a, b) => {
    const prio = { immediate: 0, high: 1, medium: 2 };
    return (prio[a.priority] || 3) - (prio[b.priority] || 3);
  });

  const totalCostBps = trades.reduce((s, t) => s + t.estimatedCostBps, 0);
  const totalSlippage = trades.reduce((s, t) => s + t.estimatedSlippage, 0);

  return {
    trades,
    totalCostBps: round2(totalCostBps / (trades.length || 1)),
    totalSlippage: round2(totalSlippage),
    tradeCount: trades.length,
    breakdown: {
      spreadCost: round2(totalSlippage * 0.4),
      impactCost: round2(totalSlippage * 0.35),
      timingCost: round2(totalSlippage * 0.25)
    }
  };
}

/**
 * Evaluate cost-benefit of rebalancing now vs waiting.
 *
 * @param {number} days
 * @returns {{ shouldRebalance, expectedBenefit, costToRebalance, netROI, recommendation }}
 */
export function evaluateRebalancingROI(days = 7) {
  const drift = trackPortfolioDrift({ days });
  const cost = estimateRebalancingCost(days);

  if (drift.driftScore < 10) {
    return {
      shouldRebalance: false,
      netROI: 0,
      recommendation: "Portfolio well-aligned — no rebalancing needed",
      driftScore: drift.driftScore
    };
  }

  // Expected benefit: proportion of drift * historical edge improvement
  const db = getDb();
  const daysOffset = `-${Math.min(days * 2, 180)} days`;

  const perfRow = db.prepare(`
    SELECT AVG(realized_pnl) as avg_pnl,
           COUNT(*) as trades
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
  `).get(daysOffset);

  const avgDailyPnl = (perfRow?.avg_pnl || 0) * (perfRow?.trades || 0) / Math.max(days, 1);

  // Drift penalty estimate: 5-20% of daily P&L lost to misallocation
  const driftPenaltyPct = Math.min(0.20, drift.driftScore / 500);
  const dailyDriftCost = Math.abs(avgDailyPnl) * driftPenaltyPct;
  const weeklyBenefit = dailyDriftCost * 7;

  const costToRebalance = cost.totalSlippage || 0;
  const netROI = costToRebalance > 0 ? round2((weeklyBenefit - costToRebalance) / costToRebalance) : 0;

  const shouldRebalance = netROI > 0.5 || drift.exceedances.some(e => e.severity === "critical");

  return {
    shouldRebalance,
    driftScore: drift.driftScore,
    expectedWeeklyBenefit: round2(weeklyBenefit),
    costToRebalance: round2(costToRebalance),
    netROI,
    paybackDays: costToRebalance > 0 && dailyDriftCost > 0
      ? round2(costToRebalance / dailyDriftCost) : 0,
    recommendation: shouldRebalance
      ? `Rebalance recommended — ${drift.exceedances.length} categories drifted, ROI ${netROI}x`
      : `Hold — drift cost ($${round2(dailyDriftCost)}/day) doesn't justify rebalancing cost ($${round2(costToRebalance)})`,
    exceedances: drift.exceedances.slice(0, 5)
  };
}

/**
 * Get full drift monitoring dashboard.
 *
 * @returns {{ drift, cost, roi }}
 */
export function getDriftDashboard() {
  const drift = trackPortfolioDrift();
  const roi = evaluateRebalancingROI();

  return {
    driftScore: drift.driftScore,
    rebalanceNeeded: drift.rebalanceNeeded,
    exceedances: drift.exceedances.slice(0, 5),
    topDrift: Object.entries(drift.driftByCategory)
      .map(([cat, d]) => ({ category: cat, ...d }))
      .sort((a, b) => b.absDrift - a.absDrift)
      .slice(0, 5),
    roi: {
      shouldRebalance: roi.shouldRebalance,
      netROI: roi.netROI,
      paybackDays: roi.paybackDays
    },
    recommendation: roi.recommendation
  };
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
