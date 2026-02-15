/**
 * Edge audit — post-settlement calibration analysis.
 * Compares predicted edge vs actual outcome to find systematic biases.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Run edge audit over settled signals.
 * @param {number} days - Lookback period (default 30)
 * @returns {object} Calibration report
 */
export function getEdgeAudit(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  // All settled signals with edge data
  const signals = db.prepare(`
    SELECT edge, side, outcome, pnl_pct, confidence, category, strength, regime,
           model_up, model_down, market_yes, market_no
    FROM signal_history
    WHERE outcome IS NOT NULL AND edge IS NOT NULL
      AND created_at >= datetime('now', ?)
    ORDER BY created_at ASC
  `).all(daysOffset);

  if (signals.length === 0) {
    return { totalAudited: 0, message: "No settled signals with edge data" };
  }

  // Overall calibration: avg predicted edge vs actual win rate
  const wins = signals.filter(s => s.outcome === "WIN").length;
  const losses = signals.filter(s => s.outcome === "LOSS").length;
  const actualWinRate = signals.length > 0 ? wins / signals.length : 0;
  const avgPredictedEdge = signals.reduce((sum, s) => sum + (s.edge || 0), 0) / signals.length;
  const calibrationBias = avgPredictedEdge - (actualWinRate - 0.5); // positive = overconfident

  // Edge accuracy by bucket (0-5%, 5-10%, 10-15%, 15%+)
  const buckets = [
    { label: "0-5%", min: 0, max: 0.05, signals: [] },
    { label: "5-10%", min: 0.05, max: 0.10, signals: [] },
    { label: "10-15%", min: 0.10, max: 0.15, signals: [] },
    { label: "15%+", min: 0.15, max: Infinity, signals: [] }
  ];

  for (const s of signals) {
    const absEdge = Math.abs(s.edge || 0);
    const bucket = buckets.find(b => absEdge >= b.min && absEdge < b.max);
    if (bucket) bucket.signals.push(s);
  }

  const edgeBuckets = buckets.map(b => ({
    range: b.label,
    total: b.signals.length,
    wins: b.signals.filter(s => s.outcome === "WIN").length,
    winRate: b.signals.length > 0 ? +(b.signals.filter(s => s.outcome === "WIN").length / b.signals.length * 100).toFixed(1) : null,
    avgEdge: b.signals.length > 0 ? +(b.signals.reduce((sum, s) => sum + (s.edge || 0), 0) / b.signals.length * 100).toFixed(2) : null
  }));

  // By category: which categories have the worst calibration
  const catMap = {};
  for (const s of signals) {
    const cat = s.category || "other";
    if (!catMap[cat]) catMap[cat] = { wins: 0, total: 0, edgeSum: 0 };
    catMap[cat].total++;
    catMap[cat].edgeSum += s.edge || 0;
    if (s.outcome === "WIN") catMap[cat].wins++;
  }

  const byCategory = Object.entries(catMap)
    .filter(([, v]) => v.total >= 3)
    .map(([cat, v]) => ({
      category: cat,
      total: v.total,
      winRate: +(v.wins / v.total * 100).toFixed(1),
      avgEdge: +(v.edgeSum / v.total * 100).toFixed(2),
      bias: +((v.edgeSum / v.total) - (v.wins / v.total - 0.5)).toFixed(4)
    }))
    .sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));

  // By strength
  const strMap = {};
  for (const s of signals) {
    const str = s.strength || "UNKNOWN";
    if (!strMap[str]) strMap[str] = { wins: 0, total: 0, edgeSum: 0 };
    strMap[str].total++;
    strMap[str].edgeSum += s.edge || 0;
    if (s.outcome === "WIN") strMap[str].wins++;
  }

  const byStrength = Object.entries(strMap)
    .map(([str, v]) => ({
      strength: str,
      total: v.total,
      winRate: +(v.wins / v.total * 100).toFixed(1),
      avgEdge: +(v.edgeSum / v.total * 100).toFixed(2),
      bias: +((v.edgeSum / v.total) - (v.wins / v.total - 0.5)).toFixed(4)
    }));

  return {
    totalAudited: signals.length,
    days,
    overall: {
      wins,
      losses,
      actualWinRate: +(actualWinRate * 100).toFixed(1),
      avgPredictedEdge: +(avgPredictedEdge * 100).toFixed(2),
      calibrationBias: +(calibrationBias * 100).toFixed(2),
      biasDirection: calibrationBias > 0.02 ? "overconfident" : calibrationBias < -0.02 ? "underconfident" : "well-calibrated"
    },
    edgeBuckets,
    byCategory,
    byStrength
  };
}
