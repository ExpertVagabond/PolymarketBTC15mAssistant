/**
 * Hedge recommendation engine.
 *
 * Analyzes current portfolio exposure and suggests hedging trades
 * to reduce systematic risk:
 *
 * - Portfolio beta to each category (how much portfolio moves with category)
 * - Category exposure imbalance (overweight/underweight detection)
 * - Side imbalance (too many YES or NO positions)
 * - Negatively-correlated market pair identification
 * - Hedge sizing recommendations
 */

import { getDb } from "../subscribers/db.js";
import { computeCorrelationMatrix } from "../engines/correlation.js";

/**
 * Get current portfolio exposure by category and side.
 * @returns {{ byCategory, bySide, totalExposure, imbalances }}
 */
export function getCategoryExposure() {
  const db = getDb();
  const positions = db.prepare(`
    SELECT market_id, question, category, side, bet_size_usd, entry_price, confidence
    FROM trade_executions WHERE status = 'open'
  `).all();

  const totalExposure = positions.reduce((s, p) => s + (p.bet_size_usd || 0), 0);

  // By category
  const catMap = {};
  for (const p of positions) {
    const cat = (p.category || "other").toLowerCase();
    if (!catMap[cat]) catMap[cat] = { positions: 0, exposure: 0, yesExposure: 0, noExposure: 0 };
    catMap[cat].positions++;
    catMap[cat].exposure += p.bet_size_usd || 0;
    if (p.side === "UP") catMap[cat].yesExposure += p.bet_size_usd || 0;
    else catMap[cat].noExposure += p.bet_size_usd || 0;
  }

  const byCategory = Object.entries(catMap)
    .map(([category, v]) => ({
      category,
      positions: v.positions,
      exposure: Math.round(v.exposure * 100) / 100,
      exposurePct: totalExposure > 0 ? Math.round((v.exposure / totalExposure) * 10000) / 100 : 0,
      yesExposure: Math.round(v.yesExposure * 100) / 100,
      noExposure: Math.round(v.noExposure * 100) / 100,
      sideBalance: v.exposure > 0 ? Math.round(((v.yesExposure - v.noExposure) / v.exposure) * 100) : 0
    }))
    .sort((a, b) => b.exposure - a.exposure);

  // Side totals
  let totalYes = 0, totalNo = 0;
  for (const p of positions) {
    if (p.side === "UP") totalYes += p.bet_size_usd || 0;
    else totalNo += p.bet_size_usd || 0;
  }

  // Imbalances
  const imbalances = [];
  for (const cat of byCategory) {
    if (cat.exposurePct > 40) {
      imbalances.push({ type: "concentration", category: cat.category, exposurePct: cat.exposurePct, severity: cat.exposurePct > 60 ? "high" : "medium" });
    }
    if (Math.abs(cat.sideBalance) > 80) {
      imbalances.push({ type: "side_imbalance", category: cat.category, sideBalance: cat.sideBalance, severity: "medium" });
    }
  }

  const overallSideBalance = totalExposure > 0 ? Math.round(((totalYes - totalNo) / totalExposure) * 100) : 0;
  if (Math.abs(overallSideBalance) > 60) {
    imbalances.push({ type: "portfolio_side_imbalance", sideBalance: overallSideBalance, severity: Math.abs(overallSideBalance) > 80 ? "high" : "medium" });
  }

  return {
    totalExposure: Math.round(totalExposure * 100) / 100,
    totalPositions: positions.length,
    byCategory,
    bySide: {
      yes: Math.round(totalYes * 100) / 100,
      no: Math.round(totalNo * 100) / 100,
      balance: overallSideBalance
    },
    imbalances
  };
}

/**
 * Compute portfolio beta to each category.
 * Beta = how much portfolio P&L moves when a category moves.
 * Estimated from historical trade returns.
 *
 * @param {number} days - lookback period
 * @returns {{ betas: object[], portfolioBeta: number }}
 */
export function getPortfolioBeta(days = 30) {
  const db = getDb();

  // Daily P&L by category
  const catDailyPnl = db.prepare(`
    SELECT date(closed_at) as day, category, SUM(pnl_usd) as cat_pnl
    FROM trade_executions
    WHERE status = 'closed' AND pnl_usd IS NOT NULL AND closed_at > datetime('now', ?)
    GROUP BY date(closed_at), category
  `).all(`-${days} days`);

  // Daily total P&L
  const totalDailyPnl = db.prepare(`
    SELECT date(closed_at) as day, SUM(pnl_usd) as total_pnl
    FROM trade_executions
    WHERE status = 'closed' AND pnl_usd IS NOT NULL AND closed_at > datetime('now', ?)
    GROUP BY date(closed_at)
  `).all(`-${days} days`);

  if (totalDailyPnl.length < 5) {
    return { betas: [], portfolioBeta: 0, insufficient: true, days };
  }

  const totalMap = {};
  for (const d of totalDailyPnl) totalMap[d.day] = d.total_pnl;

  // Group category daily returns
  const catReturns = {};
  for (const d of catDailyPnl) {
    const cat = (d.category || "other").toLowerCase();
    if (!catReturns[cat]) catReturns[cat] = [];
    catReturns[cat].push({ day: d.day, catPnl: d.cat_pnl, totalPnl: totalMap[d.day] || 0 });
  }

  // Compute beta for each category (cov(cat, total) / var(total))
  const totalPnls = totalDailyPnl.map(d => d.total_pnl);
  const totalMean = totalPnls.reduce((s, v) => s + v, 0) / totalPnls.length;
  const totalVar = totalPnls.reduce((s, v) => s + Math.pow(v - totalMean, 2), 0) / totalPnls.length;

  const betas = [];
  for (const [cat, returns] of Object.entries(catReturns)) {
    if (returns.length < 3) continue;
    const catPnls = returns.map(r => r.catPnl);
    const pairedTotal = returns.map(r => r.totalPnl);
    const catMean = catPnls.reduce((s, v) => s + v, 0) / catPnls.length;
    const pairMean = pairedTotal.reduce((s, v) => s + v, 0) / pairedTotal.length;

    let cov = 0;
    for (let i = 0; i < catPnls.length; i++) {
      cov += (catPnls[i] - catMean) * (pairedTotal[i] - pairMean);
    }
    cov /= catPnls.length;

    const beta = totalVar > 0 ? cov / totalVar : 0;
    betas.push({
      category: cat,
      beta: Math.round(beta * 1000) / 1000,
      contribution: catPnls.reduce((s, v) => s + v, 0),
      tradingDays: returns.length
    });
  }

  betas.sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));

  return { betas, portfolioBeta: 1.0, days, tradingDays: totalDailyPnl.length };
}

/**
 * Generate hedge recommendations based on current portfolio.
 * @returns {{ recommendations: object[], riskScore: number }}
 */
export function getHedgeRecommendations() {
  const exposure = getCategoryExposure();
  const recommendations = [];

  if (exposure.totalPositions === 0) {
    return { recommendations: [], riskScore: 0, message: "No open positions" };
  }

  // 1. Side imbalance hedge
  if (Math.abs(exposure.bySide.balance) > 50) {
    const overweightSide = exposure.bySide.balance > 0 ? "YES" : "NO";
    const hedgeSide = overweightSide === "YES" ? "NO" : "YES";
    const imbalanceUsd = Math.abs(exposure.bySide.yes - exposure.bySide.no) / 2;

    recommendations.push({
      type: "side_rebalance",
      priority: Math.abs(exposure.bySide.balance) > 80 ? "high" : "medium",
      action: `Add $${imbalanceUsd.toFixed(2)} in ${hedgeSide} positions`,
      reason: `Portfolio is ${Math.abs(exposure.bySide.balance)}% skewed toward ${overweightSide}`,
      suggestedAmount: Math.round(imbalanceUsd * 100) / 100
    });
  }

  // 2. Category concentration hedge
  for (const cat of exposure.byCategory) {
    if (cat.exposurePct > 50) {
      const excessUsd = (cat.exposure * (cat.exposurePct - 30) / cat.exposurePct);
      recommendations.push({
        type: "category_diversify",
        priority: cat.exposurePct > 70 ? "high" : "medium",
        action: `Reduce ${cat.category} exposure by $${excessUsd.toFixed(2)} or add positions in other categories`,
        reason: `${cat.category} is ${cat.exposurePct}% of portfolio (target: <30%)`,
        suggestedAmount: Math.round(excessUsd * 100) / 100,
        category: cat.category
      });
    }
  }

  // 3. Category side imbalance
  for (const cat of exposure.byCategory) {
    if (Math.abs(cat.sideBalance) > 90 && cat.positions > 1) {
      const hedgeSide = cat.sideBalance > 0 ? "NO" : "YES";
      recommendations.push({
        type: "category_side_hedge",
        priority: "low",
        action: `Add ${hedgeSide} positions in ${cat.category} for directional hedge`,
        reason: `All ${cat.positions} ${cat.category} positions are on one side`,
        category: cat.category
      });
    }
  }

  // Compute risk score (0-100, higher = more risk)
  let riskScore = 0;
  if (Math.abs(exposure.bySide.balance) > 50) riskScore += 20;
  if (Math.abs(exposure.bySide.balance) > 80) riskScore += 15;
  for (const cat of exposure.byCategory) {
    if (cat.exposurePct > 50) riskScore += 15;
    if (cat.exposurePct > 70) riskScore += 10;
  }
  if (exposure.byCategory.length <= 1 && exposure.totalPositions > 2) riskScore += 20;
  riskScore = Math.min(100, riskScore);

  return {
    recommendations: recommendations.sort((a, b) => {
      const prio = { high: 3, medium: 2, low: 1 };
      return (prio[b.priority] || 0) - (prio[a.priority] || 0);
    }),
    riskScore,
    riskLevel: riskScore >= 60 ? "high" : riskScore >= 30 ? "medium" : "low",
    exposure: {
      total: exposure.totalExposure,
      positions: exposure.totalPositions,
      categories: exposure.byCategory.length,
      sideBalance: exposure.bySide.balance
    }
  };
}
