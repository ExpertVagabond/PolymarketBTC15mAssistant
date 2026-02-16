/**
 * Signal replay engine.
 *
 * Replays historical signals with alternate parameter sets to simulate
 * "what-if" outcomes. Used for:
 * - Validating evolved parameters before applying them
 * - Comparing multiple strategy configurations side-by-side
 * - Backtesting filter threshold changes
 *
 * Reads from signal_history + trade_executions to simulate which signals
 * would have passed different gates and what their outcomes would be.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Replay signals from the last N days with alternate parameters.
 *
 * @param {number} days - lookback window
 * @param {object} params - parameter overrides
 * @param {number} params.minConfidence - minimum confidence threshold (0-100)
 * @param {number} params.minEdge - minimum edge threshold (0-1)
 * @param {number} params.minQuality - minimum quality score (0-10)
 * @param {string[]} params.allowedRegimes - which regimes to trade in
 * @param {string[]} params.blockedCategories - categories to skip
 * @returns {{ trades, wins, losses, winRate, totalPnl, avgPnl, filtered, params }}
 */
export function replaySignals(days = 30, params = {}) {
  const db = getDb();

  const minConf = params.minConfidence ?? 55;
  const minEdge = params.minEdge ?? 0.03;
  const minQuality = params.minQuality ?? 5;
  const allowedRegimes = params.allowedRegimes || ["TREND_UP", "TREND_DOWN", "RANGE", "CHOP"];
  const blockedCategories = params.blockedCategories || [];

  // Get historical signals with their trade outcomes
  const signals = db.prepare(`
    SELECT sh.id, sh.confidence, sh.edge, sh.regime, sh.category, sh.quality_score,
           sh.side, sh.created_at,
           te.outcome, te.pnl_usd, te.pnl_pct, te.bet_size_usd
    FROM signal_history sh
    LEFT JOIN trade_executions te ON te.signal_id = sh.id
    WHERE sh.created_at > datetime('now', ?)
    ORDER BY sh.created_at ASC
  `).all(`-${days} days`);

  let trades = 0;
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let filtered = 0;
  const categoryBreakdown = {};
  const regimeBreakdown = {};

  for (const sig of signals) {
    // Apply filters
    if ((sig.confidence || 0) < minConf) { filtered++; continue; }
    if ((sig.edge || 0) < minEdge) { filtered++; continue; }
    if ((sig.quality_score || 0) < minQuality) { filtered++; continue; }
    if (!allowedRegimes.includes(sig.regime || "RANGE")) { filtered++; continue; }
    if (blockedCategories.includes(sig.category)) { filtered++; continue; }

    // Would have traded this signal
    trades++;

    // Use actual outcome if the signal was executed, or mark as unknown
    if (sig.outcome === "WIN") {
      wins++;
      totalPnl += sig.pnl_usd || 0;
    } else if (sig.outcome === "LOSS") {
      losses++;
      totalPnl += sig.pnl_usd || 0;
    }
    // Signals without execution outcome get counted as trades but not win/loss

    // Category breakdown
    const cat = sig.category || "unknown";
    if (!categoryBreakdown[cat]) categoryBreakdown[cat] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    categoryBreakdown[cat].trades++;
    if (sig.outcome === "WIN") { categoryBreakdown[cat].wins++; categoryBreakdown[cat].pnl += sig.pnl_usd || 0; }
    if (sig.outcome === "LOSS") { categoryBreakdown[cat].losses++; categoryBreakdown[cat].pnl += sig.pnl_usd || 0; }

    // Regime breakdown
    const reg = sig.regime || "RANGE";
    if (!regimeBreakdown[reg]) regimeBreakdown[reg] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    regimeBreakdown[reg].trades++;
    if (sig.outcome === "WIN") { regimeBreakdown[reg].wins++; regimeBreakdown[reg].pnl += sig.pnl_usd || 0; }
    if (sig.outcome === "LOSS") { regimeBreakdown[reg].losses++; regimeBreakdown[reg].pnl += sig.pnl_usd || 0; }
  }

  const settled = wins + losses;
  const winRate = settled > 0 ? Math.round((wins / settled) * 1000) / 10 : null;
  const avgPnl = settled > 0 ? Math.round((totalPnl / settled) * 100) / 100 : 0;

  return {
    days,
    totalSignals: signals.length,
    trades,
    filtered,
    passRate: signals.length > 0 ? Math.round((trades / signals.length) * 1000) / 10 : 0,
    settled,
    wins,
    losses,
    winRate,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl,
    params: { minConfidence: minConf, minEdge: minEdge, minQuality: minQuality, allowedRegimes, blockedCategories },
    byCategory: Object.entries(categoryBreakdown).map(([cat, d]) => ({
      category: cat,
      trades: d.trades,
      winRate: (d.wins + d.losses) > 0 ? Math.round((d.wins / (d.wins + d.losses)) * 1000) / 10 : null,
      pnl: Math.round(d.pnl * 100) / 100
    })).sort((a, b) => b.trades - a.trades),
    byRegime: Object.entries(regimeBreakdown).map(([reg, d]) => ({
      regime: reg,
      trades: d.trades,
      winRate: (d.wins + d.losses) > 0 ? Math.round((d.wins / (d.wins + d.losses)) * 1000) / 10 : null,
      pnl: Math.round(d.pnl * 100) / 100
    })).sort((a, b) => b.trades - a.trades)
  };
}

/**
 * Compare multiple strategy configurations side by side.
 *
 * @param {number} days - lookback window
 * @param {object[]} strategies - array of { name, params } objects
 * @returns {{ strategies: object[], winner: string|null, days }}
 */
export function compareStrategies(days = 30, strategies = []) {
  if (strategies.length === 0) {
    // Default: compare current vs aggressive vs conservative
    strategies = [
      { name: "current", params: { minConfidence: 55, minEdge: 0.03, minQuality: 5 } },
      { name: "aggressive", params: { minConfidence: 45, minEdge: 0.02, minQuality: 4 } },
      { name: "conservative", params: { minConfidence: 65, minEdge: 0.05, minQuality: 6 } },
      { name: "trend_only", params: { minConfidence: 50, minEdge: 0.03, minQuality: 5, allowedRegimes: ["TREND_UP", "TREND_DOWN"] } }
    ];
  }

  const results = strategies.map(s => ({
    name: s.name,
    ...replaySignals(days, s.params)
  }));

  // Determine winner by highest total P&L with at least 5 settled trades
  const eligible = results.filter(r => r.settled >= 5);
  const winner = eligible.length > 0
    ? eligible.sort((a, b) => b.totalPnl - a.totalPnl)[0].name
    : null;

  return { strategies: results, winner, days };
}
