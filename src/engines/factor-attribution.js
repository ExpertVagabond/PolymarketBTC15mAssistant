/**
 * Factor attribution engine.
 *
 * Systematic analysis of which decision factors most predict
 * WIN vs LOSS outcomes in trade executions:
 *
 * Factors analyzed:
 * - quality_score (signal quality gate)
 * - confidence (composite confidence score)
 * - edge_at_entry (predicted edge)
 * - regime (market regime at entry)
 * - category (market category)
 * - sizing_method (Kelly/fixed/edge-proportional)
 * - hour (UTC hour of execution)
 *
 * Uses simple correlation and information gain to rank factor importance.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Compute factor importance from recent trade outcomes.
 * @param {number} days - lookback window
 * @returns {{ factors: object[], sampleSize: number, days }}
 */
export function getFactorImportance(days = 30) {
  const db = getDb();

  const trades = db.prepare(`
    SELECT quality_score, confidence, edge_at_entry, regime, category, sizing_method,
           strftime('%H', created_at) as hour, outcome, pnl_usd
    FROM trade_executions
    WHERE outcome IN ('WIN', 'LOSS') AND created_at > datetime('now', ?)
  `).all(`-${days} days`);

  if (trades.length < 20) {
    return { factors: [], sampleSize: trades.length, days, insufficient: true };
  }

  const factors = [];

  // Numeric factors: compute correlation with outcome (1=WIN, 0=LOSS)
  const numericFactors = [
    { name: "quality_score", key: "quality_score" },
    { name: "confidence", key: "confidence" },
    { name: "edge_at_entry", key: "edge_at_entry" }
  ];

  for (const f of numericFactors) {
    const pairs = trades
      .filter(t => t[f.key] != null)
      .map(t => ({ value: t[f.key], win: t.outcome === "WIN" ? 1 : 0 }));

    if (pairs.length < 10) continue;

    const corr = pearsonCorrelation(pairs.map(p => p.value), pairs.map(p => p.win));
    const avgWin = pairs.filter(p => p.win).reduce((s, p) => s + p.value, 0) / (pairs.filter(p => p.win).length || 1);
    const avgLoss = pairs.filter(p => !p.win).reduce((s, p) => s + p.value, 0) / (pairs.filter(p => !p.win).length || 1);

    factors.push({
      factor: f.name,
      type: "numeric",
      importance: Math.round(Math.abs(corr) * 1000) / 1000,
      correlation: Math.round(corr * 1000) / 1000,
      direction: corr > 0 ? "higher_is_better" : "lower_is_better",
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      samples: pairs.length
    });
  }

  // Categorical factors: compute information gain
  const categoricalFactors = [
    { name: "regime", key: "regime" },
    { name: "category", key: "category" },
    { name: "sizing_method", key: "sizing_method" },
    { name: "hour", key: "hour" }
  ];

  for (const f of categoricalFactors) {
    const groups = {};
    for (const t of trades) {
      const val = t[f.key] || "unknown";
      if (!groups[val]) groups[val] = { wins: 0, losses: 0 };
      if (t.outcome === "WIN") groups[val].wins++;
      else groups[val].losses++;
    }

    // Information gain: how much does knowing this factor reduce uncertainty?
    const baseWinRate = trades.filter(t => t.outcome === "WIN").length / trades.length;
    const baseEntropy = binaryEntropy(baseWinRate);
    let condEntropy = 0;

    const breakdown = [];
    for (const [val, counts] of Object.entries(groups)) {
      const total = counts.wins + counts.losses;
      const winRate = total > 0 ? counts.wins / total : 0;
      condEntropy += (total / trades.length) * binaryEntropy(winRate);
      if (total >= 3) {
        breakdown.push({
          value: val,
          winRate: Math.round(winRate * 1000) / 1000,
          wins: counts.wins,
          losses: counts.losses,
          total
        });
      }
    }

    const infoGain = Math.max(0, baseEntropy - condEntropy);

    factors.push({
      factor: f.name,
      type: "categorical",
      importance: Math.round(infoGain * 1000) / 1000,
      infoGain: Math.round(infoGain * 1000) / 1000,
      breakdown: breakdown.sort((a, b) => b.winRate - a.winRate),
      uniqueValues: Object.keys(groups).length,
      samples: trades.length
    });
  }

  // Sort by importance
  factors.sort((a, b) => b.importance - a.importance);

  return { factors, sampleSize: trades.length, days, baseWinRate: Math.round((trades.filter(t => t.outcome === "WIN").length / trades.length) * 1000) / 1000 };
}

/**
 * Get the profile of factors that most predict winning trades.
 * @param {number} days
 */
export function getWinningFactorProfile(days = 30) {
  const db = getDb();

  // Average factor values for wins vs losses
  const stats = db.prepare(`
    SELECT outcome,
      AVG(quality_score) as avg_quality,
      AVG(confidence) as avg_confidence,
      AVG(edge_at_entry) as avg_edge,
      AVG(bet_size_usd) as avg_bet,
      COUNT(*) as count
    FROM trade_executions
    WHERE outcome IN ('WIN', 'LOSS') AND created_at > datetime('now', ?)
    GROUP BY outcome
  `).all(`-${days} days`);

  const winRow = stats.find(s => s.outcome === "WIN") || {};
  const lossRow = stats.find(s => s.outcome === "LOSS") || {};

  return {
    winProfile: {
      avgQuality: Math.round((winRow.avg_quality || 0) * 10) / 10,
      avgConfidence: Math.round((winRow.avg_confidence || 0) * 10) / 10,
      avgEdge: Math.round((winRow.avg_edge || 0) * 1000) / 1000,
      avgBet: Math.round((winRow.avg_bet || 0) * 100) / 100,
      count: winRow.count || 0
    },
    lossProfile: {
      avgQuality: Math.round((lossRow.avg_quality || 0) * 10) / 10,
      avgConfidence: Math.round((lossRow.avg_confidence || 0) * 10) / 10,
      avgEdge: Math.round((lossRow.avg_edge || 0) * 1000) / 1000,
      avgBet: Math.round((lossRow.avg_bet || 0) * 100) / 100,
      count: lossRow.count || 0
    },
    days
  };
}

function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i] - mx;
    const yi = y[i] - my;
    num += xi * yi;
    dx += xi * xi;
    dy += yi * yi;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : 0;
}

function binaryEntropy(p) {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}
