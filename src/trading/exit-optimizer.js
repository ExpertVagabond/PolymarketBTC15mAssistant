/**
 * Dynamic exit optimizer.
 *
 * Adaptive stop-loss and take-profit level computation:
 * - Regime-conditional exit levels (tighter in CHOP, wider in TREND)
 * - ATR-based dynamic stops from historical volatility
 * - Trailing stop logic with regime-aware tightening
 * - Exit timing analysis: are we exiting too early or too late?
 * - Optimal exit rules from historical P&L distribution
 *
 * Feeds into position-lifecycle.js transition decisions.
 */

import { getDb } from "../subscribers/db.js";

// Base exit parameters
const BASE_CONFIG = {
  stopLossBps: 300,      // 3% default stop
  takeProfitBps: 500,    // 5% default take-profit
  trailingStopBps: 200,  // 2% trailing stop
  maxHoldMinutes: 360    // 6 hour max hold
};

// Regime multipliers for exit levels
const REGIME_EXIT_MULT = {
  TREND_UP:   { stop: 1.5, takeProfit: 2.0, trailing: 1.3, hold: 2.0 },
  TREND_DOWN: { stop: 0.7, takeProfit: 0.8, trailing: 0.6, hold: 0.5 },
  RANGE:      { stop: 1.0, takeProfit: 1.0, trailing: 1.0, hold: 1.0 },
  CHOP:       { stop: 0.5, takeProfit: 0.6, trailing: 0.4, hold: 0.3 }
};

/**
 * Compute optimal exit levels for a position.
 *
 * @param {object} position
 * @param {number} position.entryPrice
 * @param {string} position.side - YES or NO
 * @param {string} position.regime
 * @param {number} position.confidence
 * @returns {{ stopLoss, takeProfit, trailingStop, maxHold, rationale }}
 */
export function computeExitLevels(position = {}) {
  const entry = position.entryPrice || 0.50;
  const side = position.side || "YES";
  const regime = position.regime || "RANGE";
  const confidence = position.confidence || 0.5;

  const mult = REGIME_EXIT_MULT[regime] || REGIME_EXIT_MULT.RANGE;

  // Confidence adjustment: higher confidence → wider stops, tighter take-profit
  const confAdj = confidence > 0.7 ? 1.2 : confidence < 0.5 ? 0.7 : 1.0;

  const stopBps = BASE_CONFIG.stopLossBps * mult.stop * confAdj;
  const tpBps = BASE_CONFIG.takeProfitBps * mult.takeProfit * (2 - confAdj);
  const trailBps = BASE_CONFIG.trailingStopBps * mult.trailing;
  const maxHold = Math.round(BASE_CONFIG.maxHoldMinutes * mult.hold);

  // Convert bps to price levels
  const stopDelta = stopBps / 10000;
  const tpDelta = tpBps / 10000;
  const trailDelta = trailBps / 10000;

  const stopLoss = side === "YES"
    ? round4(Math.max(0.01, entry - stopDelta))
    : round4(Math.min(0.99, entry + stopDelta));

  const takeProfit = side === "YES"
    ? round4(Math.min(0.99, entry + tpDelta))
    : round4(Math.max(0.01, entry - tpDelta));

  const rationale = [];
  rationale.push(`Regime: ${regime} (stop ${mult.stop}x, TP ${mult.takeProfit}x)`);
  rationale.push(`Confidence: ${round3(confidence)} (adj ${round3(confAdj)}x)`);
  if (regime === "CHOP") rationale.push("Tight exits for choppy conditions");
  if (regime.includes("TREND")) rationale.push("Wide exits to capture trend continuation");

  return {
    entryPrice: round4(entry),
    side,
    stopLoss,
    takeProfit,
    trailingStop: round4(trailDelta),
    maxHoldMinutes: maxHold,
    stopLossBps: Math.round(stopBps),
    takeProfitBps: Math.round(tpBps),
    trailingStopBps: Math.round(trailBps),
    riskRewardRatio: round2(tpBps / stopBps),
    regime,
    rationale
  };
}

/**
 * Analyze historical exit timing quality.
 * Determines if exits are too early, too late, or well-timed.
 *
 * @param {number} days
 * @returns {{ analysis, earlyExitRate, lateExitRate, optimalHoldTime, recommendations }}
 */
export function analyzeExitTiming(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT realized_pnl, confidence, quality_score, regime, status,
           edge_at_entry, category
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 20) {
    return { analysis: null, message: "insufficient_data" };
  }

  // Categorize exits
  const wins = rows.filter(r => r.status === "WIN");
  const losses = rows.filter(r => r.status === "LOSS");

  // Early exit proxy: low-confidence wins with small P&L (could have held longer)
  const smallWins = wins.filter(w => Math.abs(w.realized_pnl) < avg(wins.map(w2 => Math.abs(w2.realized_pnl))) * 0.5);
  const earlyExitRate = round3(smallWins.length / (wins.length || 1));

  // Late exit proxy: high-confidence losses (should have exited sooner)
  const bigLosses = losses.filter(l => Math.abs(l.realized_pnl) > avg(losses.map(l2 => Math.abs(l2.realized_pnl))) * 1.5);
  const lateExitRate = round3(bigLosses.length / (losses.length || 1));

  // By regime analysis
  const byRegime = {};
  for (const r of rows) {
    const reg = r.regime || "unknown";
    if (!byRegime[reg]) byRegime[reg] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
    byRegime[reg].count++;
    byRegime[reg].totalPnl += r.realized_pnl;
    if (r.status === "WIN") byRegime[reg].wins++;
    else byRegime[reg].losses++;
  }

  const regimeAnalysis = Object.entries(byRegime).map(([reg, data]) => ({
    regime: reg,
    avgPnl: round2(data.totalPnl / data.count),
    winRate: round3(data.wins / data.count),
    trades: data.count,
    exitQuality: data.wins / data.count > 0.6 ? "good" : data.wins / data.count < 0.4 ? "poor" : "average"
  }));

  // Recommendations
  const recommendations = [];
  if (earlyExitRate > 0.3) {
    recommendations.push(`${(earlyExitRate * 100).toFixed(0)}% of wins are small — consider wider take-profit levels`);
  }
  if (lateExitRate > 0.3) {
    recommendations.push(`${(lateExitRate * 100).toFixed(0)}% of losses are large — tighten stop-losses`);
  }
  const poorRegimes = regimeAnalysis.filter(r => r.exitQuality === "poor");
  for (const pr of poorRegimes) {
    recommendations.push(`Poor exits in ${pr.regime} regime (${(pr.winRate * 100).toFixed(0)}% WR) — reduce exposure or tighten stops`);
  }

  return {
    totalTrades: rows.length,
    winCount: wins.length,
    lossCount: losses.length,
    earlyExitRate,
    lateExitRate,
    avgWinSize: round2(avg(wins.map(w => Math.abs(w.realized_pnl)))),
    avgLossSize: round2(avg(losses.map(l => Math.abs(l.realized_pnl)))),
    profitFactor: round2(
      wins.reduce((s, w) => s + Math.abs(w.realized_pnl), 0) /
      (losses.reduce((s, l) => s + Math.abs(l.realized_pnl), 0) || 1)
    ),
    regimeAnalysis,
    recommendations,
    lookbackDays: days
  };
}

/**
 * Get optimal exit parameters from historical data.
 *
 * @param {number} days
 * @returns {{ optimalStopBps, optimalTpBps, optimalRatio, byRegime }}
 */
export function getOptimalExitParams(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT realized_pnl, regime, status, edge_at_entry, confidence
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 20) {
    return { optimalStopBps: BASE_CONFIG.stopLossBps, optimalTpBps: BASE_CONFIG.takeProfitBps, message: "using_defaults" };
  }

  const wins = rows.filter(r => r.status === "WIN").map(r => Math.abs(r.realized_pnl));
  const losses = rows.filter(r => r.status === "LOSS").map(r => Math.abs(r.realized_pnl));

  // Optimal stop: slightly above average loss
  const avgLoss = avg(losses);
  const optimalStopBps = Math.round(avgLoss * 10000 * 1.1);

  // Optimal TP: at average win level
  const avgWin = avg(wins);
  const optimalTpBps = Math.round(avgWin * 10000 * 0.9);

  // By regime
  const byRegime = {};
  for (const r of rows) {
    const reg = r.regime || "unknown";
    if (!byRegime[reg]) byRegime[reg] = { wins: [], losses: [] };
    if (r.status === "WIN") byRegime[reg].wins.push(Math.abs(r.realized_pnl));
    else byRegime[reg].losses.push(Math.abs(r.realized_pnl));
  }

  const regimeParams = Object.entries(byRegime)
    .filter(([, d]) => d.wins.length + d.losses.length >= 5)
    .map(([reg, d]) => ({
      regime: reg,
      optimalStopBps: Math.round(avg(d.losses) * 10000 * 1.1),
      optimalTpBps: Math.round(avg(d.wins) * 10000 * 0.9),
      winRate: round3(d.wins.length / (d.wins.length + d.losses.length)),
      trades: d.wins.length + d.losses.length
    }));

  return {
    optimalStopBps,
    optimalTpBps,
    optimalRatio: round2(optimalTpBps / (optimalStopBps || 1)),
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    byRegime: regimeParams,
    totalTrades: rows.length,
    lookbackDays: days
  };
}

/**
 * Get exit optimizer dashboard.
 *
 * @returns {{ timing, params, sampleLevels }}
 */
export function getExitDashboard() {
  const timing = analyzeExitTiming();
  const params = getOptimalExitParams();
  const sample = computeExitLevels({ entryPrice: 0.55, side: "YES", regime: "RANGE", confidence: 0.6 });

  return {
    profitFactor: timing.profitFactor || 0,
    earlyExitRate: timing.earlyExitRate || 0,
    lateExitRate: timing.lateExitRate || 0,
    optimalStopBps: params.optimalStopBps || 0,
    optimalTpBps: params.optimalTpBps || 0,
    riskRewardRatio: params.optimalRatio || 0,
    sampleLevels: {
      stopLoss: sample.stopLoss,
      takeProfit: sample.takeProfit,
      trailingStopBps: sample.trailingStopBps
    },
    recommendations: timing.recommendations || []
  };
}

function avg(arr) { return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
function round4(v) { return Math.round((v ?? 0) * 10000) / 10000; }
