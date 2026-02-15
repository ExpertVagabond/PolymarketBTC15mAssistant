/**
 * Portfolio risk attribution — concentration, exposure, drawdown attribution.
 * Analyzes open and closed positions for portfolio-level risk metrics.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Get comprehensive portfolio risk metrics.
 * @returns {object} Risk attribution report
 */
export function getPortfolioRisk() {
  const db = getDb();

  // Open positions
  const open = db.prepare(`
    SELECT id, market_id, question, category, side, entry_price, current_price,
           bet_pct, confidence, edge_at_entry, opened_at
    FROM portfolio_positions WHERE status = 'open'
  `).all();

  // Closed positions for drawdown attribution
  const closed = db.prepare(`
    SELECT id, market_id, question, category, side, entry_price, current_price,
           bet_pct, pnl_pct, confidence, closed_at, close_reason
    FROM portfolio_positions WHERE status = 'closed'
    ORDER BY closed_at DESC LIMIT 200
  `).all();

  const totalExposure = open.reduce((sum, p) => sum + (p.bet_pct || 0), 0);

  // Concentration by category
  const catMap = {};
  for (const p of open) {
    const cat = p.category || "other";
    if (!catMap[cat]) catMap[cat] = { positions: 0, exposure: 0, avgConfidence: 0, confSum: 0 };
    catMap[cat].positions++;
    catMap[cat].exposure += p.bet_pct || 0;
    catMap[cat].confSum += p.confidence || 0;
  }

  const concentration = Object.entries(catMap)
    .map(([category, v]) => ({
      category,
      positions: v.positions,
      exposure: +v.exposure.toFixed(4),
      exposurePct: totalExposure > 0 ? +((v.exposure / totalExposure) * 100).toFixed(1) : 0,
      avgConfidence: v.positions > 0 ? Math.round(v.confSum / v.positions) : null
    }))
    .sort((a, b) => b.exposurePct - a.exposurePct);

  // Side exposure (long YES vs long NO)
  let yesExposure = 0;
  let noExposure = 0;
  for (const p of open) {
    if (p.side === "UP") yesExposure += p.bet_pct || 0;
    else noExposure += p.bet_pct || 0;
  }

  // Max single position risk
  const maxPosition = open.length > 0
    ? open.reduce((max, p) => (p.bet_pct || 0) > (max.bet_pct || 0) ? p : max, open[0])
    : null;

  // Drawdown attribution: which closed positions caused the biggest losses
  const losers = closed
    .filter(p => (p.pnl_pct || 0) < 0)
    .sort((a, b) => (a.pnl_pct || 0) - (b.pnl_pct || 0))
    .slice(0, 10)
    .map(p => ({
      question: p.question?.slice(0, 60),
      category: p.category,
      side: p.side,
      pnlPct: p.pnl_pct,
      confidence: p.confidence,
      closedAt: p.closed_at
    }));

  // Loss attribution by category
  const catLossMap = {};
  for (const p of closed) {
    if ((p.pnl_pct || 0) >= 0) continue;
    const cat = p.category || "other";
    if (!catLossMap[cat]) catLossMap[cat] = { totalLoss: 0, count: 0 };
    catLossMap[cat].totalLoss += p.pnl_pct;
    catLossMap[cat].count++;
  }

  const lossByCategory = Object.entries(catLossMap)
    .map(([category, v]) => ({
      category,
      totalLoss: +v.totalLoss.toFixed(2),
      lossCount: v.count,
      avgLoss: +(v.totalLoss / v.count).toFixed(2)
    }))
    .sort((a, b) => a.totalLoss - b.totalLoss);

  // Concentration risk score (HHI-inspired)
  // Higher = more concentrated = riskier
  const hhi = concentration.reduce((sum, c) => sum + Math.pow(c.exposurePct / 100, 2), 0);
  const concentrationRisk = hhi > 0.5 ? "HIGH" : hhi > 0.25 ? "MEDIUM" : "LOW";

  return {
    openPositions: open.length,
    totalExposure: +totalExposure.toFixed(4),
    totalExposurePct: +(totalExposure * 100).toFixed(2),
    sideExposure: {
      yes: +yesExposure.toFixed(4),
      yesPct: totalExposure > 0 ? +((yesExposure / totalExposure) * 100).toFixed(1) : 0,
      no: +noExposure.toFixed(4),
      noPct: totalExposure > 0 ? +((noExposure / totalExposure) * 100).toFixed(1) : 0
    },
    concentration,
    concentrationRisk,
    hhi: +hhi.toFixed(4),
    maxSinglePosition: maxPosition ? {
      question: maxPosition.question?.slice(0, 60),
      category: maxPosition.category,
      betPct: maxPosition.bet_pct,
      betPctOfTotal: totalExposure > 0 ? +((maxPosition.bet_pct / totalExposure) * 100).toFixed(1) : 0
    } : null,
    drawdownAttribution: {
      topLosers: losers,
      lossByCategory
    }
  };
}
