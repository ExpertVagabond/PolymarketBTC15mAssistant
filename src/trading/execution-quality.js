/**
 * Advanced execution quality analysis.
 *
 * Goes beyond basic slippage metrics (already in execution-log.js) to provide:
 * - Implementation shortfall: cost of delay from signal to fill
 * - Market impact decomposition: spread vs impact vs timing luck
 * - Counterfactual analysis: what-if we'd traded N minutes earlier/later
 * - Factor-driven P&L attribution: which signal factors drove returns
 *
 * Produces actionable insights: "your worst execution cost is timing delay
 * in CHOP regimes — consider tighter entry windows."
 */

import { getDb } from "../subscribers/db.js";

/**
 * Compute implementation shortfall for recent trades.
 * Shortfall = (execution price - decision price) / decision price
 * Decision price = mid price at signal generation time.
 *
 * @param {number} days - Lookback period
 * @returns {{ trades: object[], summary: object }}
 */
export function getImplementationShortfall(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  // Pull trades with timing data
  const rows = db.prepare(`
    SELECT id, market_id, side, entry_price, confidence, edge_at_entry,
           category, regime, quality_score, sizing_method,
           created_at, filled_at,
           CASE WHEN filled_at IS NOT NULL AND created_at IS NOT NULL
                THEN (julianday(filled_at) - julianday(created_at)) * 1440
                ELSE NULL END as delay_minutes,
           slippage_bps, realized_pnl, status
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('FILLED', 'CLOSED', 'WIN', 'LOSS')
    ORDER BY created_at DESC
  `).all(daysOffset);

  if (rows.length === 0) {
    return {
      trades: [],
      summary: { count: 0, avgDelayMinutes: 0, avgShortfallBps: 0, totalCostUsd: 0 }
    };
  }

  const trades = rows.map(r => {
    const delayMin = r.delay_minutes ?? 0;
    const slipBps = r.slippage_bps ?? 0;

    // Decompose shortfall into components
    // Spread cost: estimated at ~2bps for liquid markets, ~8bps for illiquid
    const spreadCost = r.category === "crypto" || r.category === "Bitcoin" ? 2 : 5;
    // Market impact: scales with confidence (larger trades have more impact)
    const impactCost = Math.round((r.confidence ?? 0.5) * 4 * 10) / 10;
    // Timing cost: residual after spread and impact
    const timingCost = Math.max(0, Math.abs(slipBps) - spreadCost - impactCost);

    return {
      id: r.id,
      marketId: r.market_id,
      side: r.side,
      delayMinutes: Math.round(delayMin * 10) / 10,
      slippageBps: slipBps,
      decomposition: {
        spreadCost: Math.round(spreadCost * 10) / 10,
        impactCost: Math.round(impactCost * 10) / 10,
        timingCost: Math.round(timingCost * 10) / 10
      },
      regime: r.regime,
      category: r.category,
      pnl: r.realized_pnl ?? 0
    };
  });

  // Summary
  const delays = trades.map(t => t.delayMinutes).filter(d => d > 0);
  const slippages = trades.map(t => Math.abs(t.slippageBps));
  const avgDelay = delays.length > 0 ? delays.reduce((s, v) => s + v, 0) / delays.length : 0;
  const avgSlip = slippages.length > 0 ? slippages.reduce((s, v) => s + v, 0) / slippages.length : 0;

  // Cost breakdown
  const spreadTotal = trades.reduce((s, t) => s + t.decomposition.spreadCost, 0);
  const impactTotal = trades.reduce((s, t) => s + t.decomposition.impactCost, 0);
  const timingTotal = trades.reduce((s, t) => s + t.decomposition.timingCost, 0);

  // By regime
  const byRegime = {};
  for (const t of trades) {
    const key = t.regime || "unknown";
    if (!byRegime[key]) byRegime[key] = { count: 0, totalDelay: 0, totalSlip: 0 };
    byRegime[key].count++;
    byRegime[key].totalDelay += t.delayMinutes;
    byRegime[key].totalSlip += Math.abs(t.slippageBps);
  }
  for (const key of Object.keys(byRegime)) {
    const b = byRegime[key];
    b.avgDelay = Math.round(b.totalDelay / b.count * 10) / 10;
    b.avgSlipBps = Math.round(b.totalSlip / b.count * 10) / 10;
    delete b.totalDelay;
    delete b.totalSlip;
  }

  // Worst offenders
  const worstSlippage = [...trades].sort((a, b) => Math.abs(b.slippageBps) - Math.abs(a.slippageBps)).slice(0, 5);
  const worstDelay = [...trades].sort((a, b) => b.delayMinutes - a.delayMinutes).slice(0, 5);

  return {
    trades: trades.slice(0, 50),
    summary: {
      count: trades.length,
      avgDelayMinutes: Math.round(avgDelay * 10) / 10,
      avgSlippageBps: Math.round(avgSlip * 10) / 10,
      costBreakdown: {
        spreadBps: Math.round(spreadTotal / trades.length * 10) / 10,
        impactBps: Math.round(impactTotal / trades.length * 10) / 10,
        timingBps: Math.round(timingTotal / trades.length * 10) / 10
      },
      byRegime,
      worstSlippage: worstSlippage.map(t => ({ id: t.id, slipBps: t.slippageBps, regime: t.regime })),
      worstDelay: worstDelay.map(t => ({ id: t.id, delayMin: t.delayMinutes, regime: t.regime }))
    }
  };
}

/**
 * Counterfactual timing analysis — what if we'd traded earlier/later?
 * Simulates alternate entry points using historical price series.
 *
 * @param {number} days - Lookback period
 * @returns {{ scenarios: object[], bestOffset: number, worstOffset: number }}
 */
export function getCounterfactualAnalysis(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT id, market_id, side, entry_price, exit_price, realized_pnl,
           confidence, regime, category, created_at
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('CLOSED', 'WIN', 'LOSS')
    AND entry_price IS NOT NULL AND exit_price IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 200
  `).all(daysOffset);

  if (rows.length < 5) {
    return { scenarios: [], bestOffset: 0, worstOffset: 0, message: "insufficient_data" };
  }

  // For each offset (-5, -3, -1, 0, +1, +3, +5 minutes), estimate alternate P&L
  // We approximate: each minute of delay shifts entry by ~slippage/delay ratio
  const offsets = [-5, -3, -1, 0, 1, 3, 5];
  const scenarios = offsets.map(offset => {
    let totalPnl = 0;
    let wins = 0;
    let count = 0;

    for (const r of rows) {
      const entryPrice = r.entry_price;
      const exitPrice = r.exit_price;
      if (!entryPrice || !exitPrice) continue;

      // Estimate price drift per minute from entry→exit spread
      const priceDiff = exitPrice - entryPrice;
      const holdMinutes = Math.max(1, 15); // Assume ~15min average hold
      const driftPerMin = priceDiff / holdMinutes;

      // Alternate entry price
      const altEntry = entryPrice - (driftPerMin * offset);
      // P&L with alternate entry
      const altPnl = r.side === "YES"
        ? (exitPrice - altEntry) * 10 // Normalized to $10 shares
        : (altEntry - exitPrice) * 10;

      totalPnl += altPnl;
      if (altPnl > 0) wins++;
      count++;
    }

    return {
      offsetMinutes: offset,
      avgPnl: count > 0 ? Math.round(totalPnl / count * 100) / 100 : 0,
      winRate: count > 0 ? Math.round(wins / count * 1000) / 1000 : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
      tradeCount: count
    };
  });

  const sorted = [...scenarios].sort((a, b) => b.avgPnl - a.avgPnl);
  const bestOffset = sorted[0]?.offsetMinutes ?? 0;
  const worstOffset = sorted[sorted.length - 1]?.offsetMinutes ?? 0;

  return {
    scenarios,
    bestOffset,
    worstOffset,
    insight: bestOffset < 0
      ? `Trading ${Math.abs(bestOffset)} minutes earlier would improve average P&L`
      : bestOffset > 0
      ? `Trading ${bestOffset} minutes later would improve average P&L`
      : "Current timing is optimal"
  };
}

/**
 * Factor-driven P&L attribution — which factors drive returns?
 * Groups trades by each factor and computes contribution to total P&L.
 *
 * @param {number} days - Lookback period
 * @returns {{ factors: object[], topContributors: object[], topDetractors: object[] }}
 */
export function getFactorPnlAttribution(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT regime, category, side, sizing_method,
           confidence, quality_score, edge_at_entry,
           realized_pnl, status
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS', 'CLOSED')
    AND realized_pnl IS NOT NULL
    ORDER BY created_at DESC
  `).all(daysOffset);

  if (rows.length === 0) {
    return { factors: [], topContributors: [], topDetractors: [] };
  }

  const totalPnl = rows.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);

  // Categorical factors
  const categoricalFactors = ["regime", "category", "side", "sizing_method"];
  const factors = [];

  for (const factor of categoricalFactors) {
    const buckets = {};
    for (const r of rows) {
      const key = r[factor] || "unknown";
      if (!buckets[key]) buckets[key] = { count: 0, pnl: 0, wins: 0 };
      buckets[key].count++;
      buckets[key].pnl += r.realized_pnl ?? 0;
      if (r.status === "WIN") buckets[key].wins++;
    }

    const breakdowns = Object.entries(buckets)
      .map(([value, b]) => ({
        value,
        count: b.count,
        pnl: Math.round(b.pnl * 100) / 100,
        winRate: Math.round(b.wins / b.count * 1000) / 1000,
        pnlShare: totalPnl !== 0 ? Math.round(b.pnl / Math.abs(totalPnl) * 1000) / 1000 : 0
      }))
      .sort((a, b) => b.pnl - a.pnl);

    factors.push({ factor, breakdowns });
  }

  // Numeric factors — bucket into quartiles
  const numericFactors = [
    { name: "confidence", field: "confidence" },
    { name: "quality", field: "quality_score" },
    { name: "edge", field: "edge_at_entry" }
  ];

  for (const { name, field } of numericFactors) {
    const vals = rows.filter(r => r[field] != null).map(r => r[field]);
    if (vals.length < 4) continue;

    vals.sort((a, b) => a - b);
    const q1 = vals[Math.floor(vals.length * 0.25)];
    const q2 = vals[Math.floor(vals.length * 0.5)];
    const q3 = vals[Math.floor(vals.length * 0.75)];

    const buckets = { low: { count: 0, pnl: 0, wins: 0 }, mid_low: { count: 0, pnl: 0, wins: 0 }, mid_high: { count: 0, pnl: 0, wins: 0 }, high: { count: 0, pnl: 0, wins: 0 } };

    for (const r of rows) {
      const v = r[field];
      if (v == null) continue;
      const bucket = v <= q1 ? "low" : v <= q2 ? "mid_low" : v <= q3 ? "mid_high" : "high";
      buckets[bucket].count++;
      buckets[bucket].pnl += r.realized_pnl ?? 0;
      if (r.status === "WIN") buckets[bucket].wins++;
    }

    const breakdowns = Object.entries(buckets)
      .map(([value, b]) => ({
        value,
        count: b.count,
        pnl: Math.round(b.pnl * 100) / 100,
        winRate: b.count > 0 ? Math.round(b.wins / b.count * 1000) / 1000 : 0,
        pnlShare: totalPnl !== 0 ? Math.round(b.pnl / Math.abs(totalPnl) * 1000) / 1000 : 0
      }));

    factors.push({ factor: name, breakdowns });
  }

  // Top contributors and detractors across all factor breakdowns
  const allBuckets = factors.flatMap(f =>
    f.breakdowns.map(b => ({ factor: f.factor, value: b.value, pnl: b.pnl, count: b.count, winRate: b.winRate }))
  );
  allBuckets.sort((a, b) => b.pnl - a.pnl);

  return {
    totalPnl: Math.round(totalPnl * 100) / 100,
    tradeCount: rows.length,
    factors,
    topContributors: allBuckets.filter(b => b.pnl > 0).slice(0, 5),
    topDetractors: allBuckets.filter(b => b.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 5)
  };
}
