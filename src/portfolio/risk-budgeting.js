/**
 * Risk budgeting & Value-at-Risk framework.
 *
 * Bridges per-trade Kelly sizing with portfolio-level risk management:
 * - Historical VaR: loss threshold at given confidence from actual P&L
 * - Parametric VaR: normal-distribution VaR from mean/stddev
 * - CVaR (Expected Shortfall): average loss beyond VaR threshold
 * - Per-market risk budgets: allocate total risk budget across markets
 * - Dynamic reallocation: shift risk budget based on regime
 * - Risk decomposition: which positions contribute most to portfolio risk
 */

import { getDb } from "../subscribers/db.js";

// Default risk budget parameters
const DEFAULT_BUDGET = {
  totalRiskUsd: 100,           // Total daily risk budget in USD
  confidenceLevel: 0.95,       // 95% VaR
  maxPerMarketPct: 0.20,       // Max 20% of risk budget per market
  regimeMultipliers: {
    TREND_UP: 1.1,             // Slightly more risk in trends
    TREND_DOWN: 1.1,
    RANGE: 0.9,
    CHOP: 0.6                  // Much less risk in chop
  }
};

/**
 * Compute Value-at-Risk and CVaR from recent trade P&L.
 *
 * @param {number} days - Lookback period
 * @param {object} opts
 * @param {number} opts.confidence - Confidence level (0.90, 0.95, 0.99)
 * @returns {{ historicalVaR, parametricVaR, cvar, dailyPnls, summary }}
 */
export function computeVaR(days = 30, opts = {}) {
  const db = getDb();
  const confidence = opts.confidence || DEFAULT_BUDGET.confidenceLevel;
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  // Get daily P&L aggregates
  const rows = db.prepare(`
    SELECT date(created_at) as trade_date,
           SUM(realized_pnl) as daily_pnl,
           COUNT(*) as trade_count,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS', 'CLOSED')
    AND realized_pnl IS NOT NULL
    GROUP BY date(created_at)
    ORDER BY trade_date
  `).all(daysOffset);

  if (rows.length < 5) {
    return {
      historicalVaR: 0, parametricVaR: 0, cvar: 0,
      dailyPnls: [], summary: { days: 0, message: "insufficient_data" }
    };
  }

  const pnls = rows.map(r => r.daily_pnl);
  const sorted = [...pnls].sort((a, b) => a - b);

  // Historical VaR: percentile of actual losses
  const varIndex = Math.floor(sorted.length * (1 - confidence));
  const historicalVaR = Math.abs(sorted[varIndex] ?? 0);

  // Parametric VaR: assume normal distribution
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length);
  const zScore = confidence === 0.99 ? 2.326 : confidence === 0.95 ? 1.645 : 1.282;
  const parametricVaR = Math.abs(mean - zScore * std);

  // CVaR (Expected Shortfall): average of losses beyond VaR
  const tailLosses = sorted.slice(0, varIndex + 1);
  const cvar = tailLosses.length > 0
    ? Math.abs(tailLosses.reduce((s, v) => s + v, 0) / tailLosses.length)
    : historicalVaR;

  // Daily P&L series for display
  const dailyPnls = rows.map(r => ({
    date: r.trade_date,
    pnl: Math.round(r.daily_pnl * 100) / 100,
    trades: r.trade_count,
    winRate: r.trade_count > 0 ? Math.round(r.wins / r.trade_count * 1000) / 1000 : 0,
    breachesVaR: r.daily_pnl < -historicalVaR
  }));

  const breachDays = dailyPnls.filter(d => d.breachesVaR).length;
  const expectedBreaches = Math.round(rows.length * (1 - confidence));

  return {
    historicalVaR: Math.round(historicalVaR * 100) / 100,
    parametricVaR: Math.round(parametricVaR * 100) / 100,
    cvar: Math.round(cvar * 100) / 100,
    confidence,
    dailyPnls: dailyPnls.slice(-30),
    summary: {
      days: rows.length,
      meanDailyPnl: Math.round(mean * 100) / 100,
      dailyStdDev: Math.round(std * 100) / 100,
      sharpeDaily: std > 0 ? Math.round(mean / std * 100) / 100 : 0,
      breachDays,
      expectedBreaches,
      breachAccuracy: expectedBreaches > 0
        ? Math.round(breachDays / expectedBreaches * 100) / 100
        : null,
      worstDay: Math.round(sorted[0] * 100) / 100,
      bestDay: Math.round(sorted[sorted.length - 1] * 100) / 100
    }
  };
}

/**
 * Compute per-market risk budgets.
 * Allocates total risk budget inversely proportional to per-market volatility.
 *
 * @param {object} opts
 * @param {number} opts.totalRiskUsd - Total daily risk budget
 * @param {string} opts.currentRegime - Current market regime
 * @returns {{ budgets: object[], summary: object }}
 */
export function getRiskBudgets(opts = {}) {
  const db = getDb();
  const totalRisk = opts.totalRiskUsd || DEFAULT_BUDGET.totalRiskUsd;
  const regime = opts.currentRegime || "RANGE";
  const regimeMult = DEFAULT_BUDGET.regimeMultipliers[regime] ?? 1.0;
  const adjustedRisk = totalRisk * regimeMult;

  // Get per-market volatility from recent trades
  const rows = db.prepare(`
    SELECT market_id, category,
           AVG(realized_pnl) as avg_pnl,
           COUNT(*) as trades,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins
    FROM trade_executions
    WHERE created_at > datetime('now', '-14 days')
    AND status IN ('WIN', 'LOSS', 'CLOSED')
    AND realized_pnl IS NOT NULL
    GROUP BY market_id
    HAVING COUNT(*) >= 3
  `).all();

  if (rows.length === 0) {
    return {
      budgets: [],
      summary: { totalBudget: adjustedRisk, regime, regimeMultiplier: regimeMult, marketCount: 0 }
    };
  }

  // Compute per-market P&L volatility
  const marketVols = rows.map(r => {
    const marketPnls = db.prepare(`
      SELECT realized_pnl FROM trade_executions
      WHERE market_id = ? AND created_at > datetime('now', '-14 days')
      AND status IN ('WIN', 'LOSS', 'CLOSED') AND realized_pnl IS NOT NULL
    `).all(r.market_id).map(p => p.realized_pnl);

    const mean = marketPnls.reduce((s, v) => s + v, 0) / marketPnls.length;
    const vol = Math.sqrt(marketPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / marketPnls.length);

    return {
      marketId: r.market_id,
      category: r.category,
      trades: r.trades,
      winRate: Math.round(r.wins / r.trades * 1000) / 1000,
      avgPnl: Math.round(r.avg_pnl * 100) / 100,
      volatility: vol
    };
  });

  // Inverse-volatility weighting: lower vol markets get more budget
  const totalInvVol = marketVols.reduce((s, m) => s + (m.volatility > 0 ? 1 / m.volatility : 1), 0);

  const budgets = marketVols.map(m => {
    const weight = m.volatility > 0 ? (1 / m.volatility) / totalInvVol : 1 / marketVols.length;
    const rawBudget = adjustedRisk * weight;
    // Cap at maxPerMarketPct
    const cappedBudget = Math.min(rawBudget, adjustedRisk * DEFAULT_BUDGET.maxPerMarketPct);

    return {
      ...m,
      volatility: Math.round(m.volatility * 100) / 100,
      weight: Math.round(weight * 1000) / 1000,
      budgetUsd: Math.round(cappedBudget * 100) / 100,
      budgetPct: Math.round(cappedBudget / adjustedRisk * 1000) / 1000
    };
  });

  budgets.sort((a, b) => b.budgetUsd - a.budgetUsd);

  const allocated = budgets.reduce((s, b) => s + b.budgetUsd, 0);

  return {
    budgets: budgets.slice(0, 20),
    summary: {
      totalBudget: Math.round(adjustedRisk * 100) / 100,
      allocated: Math.round(allocated * 100) / 100,
      unallocated: Math.round((adjustedRisk - allocated) * 100) / 100,
      regime,
      regimeMultiplier: regimeMult,
      marketCount: budgets.length,
      maxPerMarket: Math.round(adjustedRisk * DEFAULT_BUDGET.maxPerMarketPct * 100) / 100
    }
  };
}

/**
 * Risk decomposition — which positions contribute most to portfolio risk?
 *
 * @returns {{ positions: object[], concentrationIndex: number, recommendation: string }}
 */
export function getRiskDecomposition() {
  const db = getDb();

  const positions = db.prepare(`
    SELECT market_id, category, side, shares, entry_price,
           current_price, unrealized_pnl, confidence
    FROM open_positions
    WHERE status = 'OPEN'
  `).all();

  if (positions.length === 0) {
    return { positions: [], concentrationIndex: 0, recommendation: "No open positions." };
  }

  // Compute risk contribution per position
  const totalExposure = positions.reduce((s, p) => s + Math.abs((p.shares ?? 1) * (p.current_price ?? 0.5)), 0) || 1;

  const riskPositions = positions.map(p => {
    const exposure = Math.abs((p.shares ?? 1) * (p.current_price ?? p.entry_price ?? 0.5));
    const maxLoss = (p.shares ?? 1) * (p.entry_price ?? 0.5); // Binary market: max loss = entry cost
    const distFromEntry = Math.abs((p.current_price ?? 0.5) - (p.entry_price ?? 0.5));

    // Risk score: combines position size, distance from entry, and max loss
    const sizeRisk = exposure / totalExposure * 40;
    const moveRisk = distFromEntry * 60;
    const riskScore = Math.min(100, Math.round(sizeRisk + moveRisk));

    return {
      marketId: p.market_id,
      category: p.category,
      side: p.side,
      exposure: Math.round(exposure * 100) / 100,
      exposurePct: Math.round(exposure / totalExposure * 1000) / 1000,
      maxLoss: Math.round(maxLoss * 100) / 100,
      unrealizedPnl: Math.round((p.unrealized_pnl ?? 0) * 100) / 100,
      riskScore
    };
  });

  riskPositions.sort((a, b) => b.riskScore - a.riskScore);

  // Herfindahl-Hirschman concentration index
  const hhi = riskPositions.reduce((s, p) => s + p.exposurePct ** 2, 0);
  const concentrationIndex = Math.round(hhi * 10000);

  // Category concentration
  const catExposure = {};
  for (const p of riskPositions) {
    catExposure[p.category || "unknown"] = (catExposure[p.category || "unknown"] || 0) + p.exposurePct;
  }

  const maxCatConc = Math.max(...Object.values(catExposure));

  return {
    positions: riskPositions.slice(0, 15),
    totalExposure: Math.round(totalExposure * 100) / 100,
    concentrationIndex,
    categoryConcentration: Object.fromEntries(
      Object.entries(catExposure).map(([k, v]) => [k, Math.round(v * 1000) / 1000])
    ),
    recommendation: concentrationIndex > 5000
      ? "High concentration risk. Diversify across more markets."
      : maxCatConc > 0.4
      ? "Category concentration detected. Balance across categories."
      : "Risk is well-distributed across positions."
  };
}
