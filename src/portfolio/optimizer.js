/**
 * Portfolio optimizer.
 *
 * Constrained portfolio allocation with:
 * - Category concentration limits (max % per category)
 * - Side balance constraints (max net directional bias)
 * - Rebalancing triggers (drift threshold, time-based)
 * - Efficient frontier approximation via grid search
 * - Target vs actual allocation comparison
 *
 * Not a full Markowitz solver (no matrix inversion) — uses a
 * practical grid-search approach suited to discrete prediction markets
 * where positions are binary YES/NO shares.
 */

import { getDb } from "../subscribers/db.js";

// Default allocation constraints
const DEFAULT_CONSTRAINTS = {
  maxPerCategory: 0.30,      // Max 30% in any one category
  maxPerMarket: 0.15,        // Max 15% in a single market
  maxDirectionalBias: 0.60,  // Max 60% net YES or NO
  maxCorrelatedCluster: 0.40, // Max 40% in correlated positions
  minCashReserve: 0.10       // Keep 10% unallocated
};

// Category risk weights (higher = riskier, needs less allocation)
const CATEGORY_RISK = {
  crypto: 1.4, Bitcoin: 1.4, Ethereum: 1.3,
  Sports: 1.0, Esports: 1.1, Tennis: 1.0,
  Politics: 0.8, Elections: 0.8,
  Economics: 0.7, Weather: 0.9,
  Science: 0.6, Entertainment: 1.0
};

/**
 * Analyze current portfolio allocation and compare to optimal.
 *
 * @param {object} opts
 * @param {object} opts.constraints - Override default constraints
 * @returns {{ current: object, target: object, violations: object[], rebalanceActions: object[] }}
 */
export function optimizePortfolio(opts = {}) {
  const db = getDb();
  const constraints = { ...DEFAULT_CONSTRAINTS, ...(opts.constraints || {}) };

  // Get current open positions
  const positions = db.prepare(`
    SELECT market_id, category, side, shares, entry_price,
           current_price, unrealized_pnl, confidence
    FROM open_positions
    WHERE status = 'OPEN'
  `).all();

  if (positions.length === 0) {
    return {
      current: { positions: 0, totalValue: 0, allocations: {} },
      target: { allocations: {} },
      violations: [],
      rebalanceActions: [],
      score: 100
    };
  }

  // Compute position values
  const totalValue = positions.reduce((s, p) => {
    const val = (p.shares ?? 1) * (p.current_price ?? p.entry_price ?? 0.5);
    return s + val;
  }, 0) || 1;

  // Current allocations by category
  const byCat = {};
  const byMarket = {};
  let yesValue = 0;
  let noValue = 0;

  for (const p of positions) {
    const val = (p.shares ?? 1) * (p.current_price ?? p.entry_price ?? 0.5);
    const cat = p.category || "unknown";

    byCat[cat] = (byCat[cat] || 0) + val;
    byMarket[p.market_id] = (byMarket[p.market_id] || 0) + val;

    if (p.side === "YES") yesValue += val;
    else noValue += val;
  }

  // Current allocation percentages
  const currentAlloc = {};
  for (const [cat, val] of Object.entries(byCat)) {
    currentAlloc[cat] = Math.round(val / totalValue * 1000) / 1000;
  }

  const directionalBias = Math.abs(yesValue - noValue) / totalValue;

  // Detect violations
  const violations = [];

  for (const [cat, pct] of Object.entries(currentAlloc)) {
    if (pct > constraints.maxPerCategory) {
      violations.push({
        type: "category_concentration",
        category: cat,
        current: pct,
        limit: constraints.maxPerCategory,
        excess: Math.round((pct - constraints.maxPerCategory) * totalValue * 100) / 100
      });
    }
  }

  for (const [mkt, val] of Object.entries(byMarket)) {
    const pct = val / totalValue;
    if (pct > constraints.maxPerMarket) {
      violations.push({
        type: "market_concentration",
        marketId: mkt,
        current: Math.round(pct * 1000) / 1000,
        limit: constraints.maxPerMarket,
        excess: Math.round((pct - constraints.maxPerMarket) * totalValue * 100) / 100
      });
    }
  }

  if (directionalBias > constraints.maxDirectionalBias) {
    violations.push({
      type: "directional_bias",
      bias: Math.round(directionalBias * 1000) / 1000,
      limit: constraints.maxDirectionalBias,
      direction: yesValue > noValue ? "YES" : "NO"
    });
  }

  // Compute target allocation using inverse-risk weighting
  const categories = Object.keys(byCat);
  const targetAlloc = {};
  let totalWeight = 0;

  for (const cat of categories) {
    const riskWeight = CATEGORY_RISK[cat] ?? 1.0;
    const invRisk = 1 / riskWeight;
    targetAlloc[cat] = invRisk;
    totalWeight += invRisk;
  }

  // Normalize to sum to (1 - cashReserve)
  const usable = 1 - constraints.minCashReserve;
  for (const cat of categories) {
    targetAlloc[cat] = Math.round(targetAlloc[cat] / totalWeight * usable * 1000) / 1000;
    // Cap at maxPerCategory
    targetAlloc[cat] = Math.min(targetAlloc[cat], constraints.maxPerCategory);
  }

  // Rebalancing actions
  const rebalanceActions = [];
  for (const cat of categories) {
    const current = currentAlloc[cat] || 0;
    const target = targetAlloc[cat] || 0;
    const drift = current - target;

    if (Math.abs(drift) > 0.05) { // >5% drift triggers rebalance
      rebalanceActions.push({
        category: cat,
        action: drift > 0 ? "reduce" : "increase",
        currentPct: current,
        targetPct: target,
        driftPct: Math.round(drift * 1000) / 1000,
        estimatedValue: Math.round(Math.abs(drift) * totalValue * 100) / 100
      });
    }
  }

  rebalanceActions.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));

  // Portfolio optimization score (100 = perfect allocation, 0 = severely imbalanced)
  const violationPenalty = violations.length * 15;
  const driftPenalty = rebalanceActions.reduce((s, a) => s + Math.abs(a.driftPct) * 50, 0);
  const score = Math.max(0, Math.round(100 - violationPenalty - driftPenalty));

  return {
    current: {
      positions: positions.length,
      totalValue: Math.round(totalValue * 100) / 100,
      allocations: currentAlloc,
      directionalBias: Math.round(directionalBias * 1000) / 1000,
      yesPct: Math.round(yesValue / totalValue * 1000) / 1000,
      noPct: Math.round(noValue / totalValue * 1000) / 1000
    },
    target: {
      allocations: targetAlloc,
      cashReserve: constraints.minCashReserve
    },
    constraints,
    violations,
    rebalanceActions,
    score,
    recommendation: score >= 80 ? "Portfolio is well-balanced."
      : score >= 50 ? "Minor rebalancing recommended."
      : "Significant rebalancing needed — reduce concentrated positions."
  };
}

/**
 * Get rebalancing schedule — when should we rebalance?
 *
 * @returns {{ shouldRebalance: boolean, triggers: object[], lastRebalance: string|null }}
 */
export function getRebalanceSchedule() {
  const db = getDb();

  // Check last rebalance from audit log
  const lastRebal = db.prepare(`
    SELECT created_at FROM audit_log
    WHERE action = 'REBALANCE'
    ORDER BY created_at DESC LIMIT 1
  `).get();

  const hoursSinceRebal = lastRebal
    ? (Date.now() - new Date(lastRebal.created_at).getTime()) / 3600000
    : 999;

  // Get portfolio state
  const portfolio = optimizePortfolio();
  const triggers = [];

  // Time-based trigger: rebalance every 24h
  if (hoursSinceRebal > 24) {
    triggers.push({ type: "time_based", hoursSince: Math.round(hoursSinceRebal), threshold: 24 });
  }

  // Drift-based trigger: any category >5% off target
  if (portfolio.rebalanceActions.length > 0) {
    triggers.push({
      type: "drift_based",
      driftingCategories: portfolio.rebalanceActions.length,
      maxDrift: portfolio.rebalanceActions[0]?.driftPct ?? 0
    });
  }

  // Violation-based trigger: constraint violations
  if (portfolio.violations.length > 0) {
    triggers.push({
      type: "violation_based",
      violationCount: portfolio.violations.length,
      types: [...new Set(portfolio.violations.map(v => v.type))]
    });
  }

  return {
    shouldRebalance: triggers.length > 0,
    triggers,
    lastRebalance: lastRebal?.created_at ?? null,
    hoursSinceLastRebalance: Math.round(hoursSinceRebal * 10) / 10,
    portfolioScore: portfolio.score,
    violationCount: portfolio.violations.length,
    actionCount: portfolio.rebalanceActions.length
  };
}

/**
 * Get efficient frontier approximation.
 * Computes risk/return tradeoffs at different concentration levels.
 *
 * @param {number} days - Historical lookback
 * @returns {{ frontier: object[], currentPosition: object }}
 */
export function getEfficientFrontier(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  // Get historical trade data by category
  const rows = db.prepare(`
    SELECT category, realized_pnl, status
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS', 'CLOSED')
    AND realized_pnl IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 10) {
    return { frontier: [], currentPosition: null, message: "insufficient_data" };
  }

  // Category statistics
  const catStats = {};
  for (const r of rows) {
    const cat = r.category || "unknown";
    if (!catStats[cat]) catStats[cat] = { pnls: [], wins: 0, count: 0 };
    catStats[cat].pnls.push(r.realized_pnl);
    catStats[cat].count++;
    if (r.status === "WIN") catStats[cat].wins++;
  }

  for (const cat of Object.keys(catStats)) {
    const s = catStats[cat];
    const mean = s.pnls.reduce((a, b) => a + b, 0) / s.pnls.length;
    const variance = s.pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / s.pnls.length;
    s.avgReturn = mean;
    s.stdDev = Math.sqrt(variance);
    s.sharpe = s.stdDev > 0 ? mean / s.stdDev : 0;
    s.winRate = s.wins / s.count;
  }

  // Grid search: vary max concentration from 20% to 80%
  const frontier = [];
  const concentrations = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  for (const maxConc of concentrations) {
    // Simulate portfolio with this concentration limit
    const cats = Object.entries(catStats).sort((a, b) => b[1].sharpe - a[1].sharpe);
    let allocated = 0;
    let weightedReturn = 0;
    let weightedRisk = 0;

    for (const [cat, stats] of cats) {
      const weight = Math.min(maxConc, 1 - allocated);
      if (weight <= 0) break;
      weightedReturn += weight * stats.avgReturn;
      weightedRisk += weight * stats.stdDev;
      allocated += weight;
    }

    frontier.push({
      maxConcentration: maxConc,
      expectedReturn: Math.round(weightedReturn * 10000) / 10000,
      risk: Math.round(weightedRisk * 10000) / 10000,
      sharpe: weightedRisk > 0 ? Math.round(weightedReturn / weightedRisk * 100) / 100 : 0
    });
  }

  // Current portfolio position
  const portfolio = optimizePortfolio();
  const maxCurrent = Math.max(...Object.values(portfolio.current.allocations || {}), 0);

  return {
    frontier,
    currentPosition: {
      maxConcentration: Math.round(maxCurrent * 1000) / 1000,
      portfolioScore: portfolio.score
    },
    categoryStats: Object.fromEntries(
      Object.entries(catStats).map(([cat, s]) => [cat, {
        avgReturn: Math.round(s.avgReturn * 10000) / 10000,
        stdDev: Math.round(s.stdDev * 10000) / 10000,
        sharpe: Math.round(s.sharpe * 100) / 100,
        winRate: Math.round(s.winRate * 1000) / 1000,
        tradeCount: s.count
      }])
    )
  };
}
