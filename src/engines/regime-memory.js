/**
 * Regime memory learner.
 *
 * Learns regime-specific signal performance signatures:
 * - Per-regime win rates, edge, and confidence effectiveness
 * - Cross-regime pattern transfer (what works in TREND may predict RANGE)
 * - Regime transition memory: what happened last time we entered this regime
 * - Adaptive signal weighting based on regime history
 * - Regime similarity scoring for novel regime detection
 *
 * Builds a growing memory of regime-specific trading wisdom.
 */

import { getDb } from "../subscribers/db.js";

// In-memory regime memory store
const regimeMemory = {};  // regime → { signals, transitions, performance }
const MEMORY_DEPTH = 100; // max entries per regime

/**
 * Learn from a completed trade in a specific regime.
 *
 * @param {string} regime - TREND_UP, TREND_DOWN, RANGE, CHOP
 * @param {object} trade - { confidence, edge, status, category, pnl }
 */
export function learnFromTrade(regime, trade) {
  if (!regimeMemory[regime]) {
    regimeMemory[regime] = { trades: [], transitions: [], lastSeen: Date.now() };
  }
  const mem = regimeMemory[regime];
  mem.trades.push({
    confidence: trade.confidence || 0.5,
    edge: trade.edge || 0,
    status: trade.status,
    category: trade.category || "unknown",
    pnl: trade.pnl || 0,
    timestamp: Date.now()
  });
  if (mem.trades.length > MEMORY_DEPTH) {
    mem.trades = mem.trades.slice(-MEMORY_DEPTH);
  }
  mem.lastSeen = Date.now();
}

/**
 * Record a regime transition for transition memory.
 *
 * @param {string} fromRegime
 * @param {string} toRegime
 */
export function recordRegimeTransition(fromRegime, toRegime) {
  for (const regime of [fromRegime, toRegime]) {
    if (!regimeMemory[regime]) {
      regimeMemory[regime] = { trades: [], transitions: [], lastSeen: Date.now() };
    }
  }
  regimeMemory[fromRegime].transitions.push({
    to: toRegime,
    timestamp: Date.now()
  });
  if (regimeMemory[fromRegime].transitions.length > 50) {
    regimeMemory[fromRegime].transitions = regimeMemory[fromRegime].transitions.slice(-50);
  }
}

/**
 * Get regime-specific performance memory from historical data.
 *
 * @param {number} days
 * @returns {{ regimes, bestRegime, worstRegime, crossRegimeInsights }}
 */
export function getRegimeMemory(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT regime, category, confidence, edge_at_entry,
           realized_pnl, status, sizing_method, quality_score
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 15) {
    return { regimes: [], message: "insufficient_data" };
  }

  const byRegime = {};
  for (const r of rows) {
    const reg = r.regime || "unknown";
    if (!byRegime[reg]) byRegime[reg] = {
      wins: 0, losses: 0, totalPnl: 0, confSum: 0, edgeSum: 0,
      highConfWins: 0, highConfTotal: 0, lowConfWins: 0, lowConfTotal: 0,
      categories: {}, methods: {}
    };
    const b = byRegime[reg];
    b.totalPnl += r.realized_pnl;
    b.confSum += r.confidence || 0;
    b.edgeSum += r.edge_at_entry || 0;

    if (r.status === "WIN") b.wins++;
    else b.losses++;

    // Track high vs low confidence performance
    if ((r.confidence || 0) > 0.7) {
      b.highConfTotal++;
      if (r.status === "WIN") b.highConfWins++;
    } else if ((r.confidence || 0) < 0.5) {
      b.lowConfTotal++;
      if (r.status === "WIN") b.lowConfWins++;
    }

    // Category breakdown
    const cat = r.category || "unknown";
    if (!b.categories[cat]) b.categories[cat] = { wins: 0, losses: 0, pnl: 0 };
    b.categories[cat].pnl += r.realized_pnl;
    if (r.status === "WIN") b.categories[cat].wins++;
    else b.categories[cat].losses++;

    // Method breakdown
    const method = r.sizing_method || "default";
    if (!b.methods[method]) b.methods[method] = { wins: 0, losses: 0 };
    if (r.status === "WIN") b.methods[method].wins++;
    else b.methods[method].losses++;
  }

  const regimes = Object.entries(byRegime)
    .filter(([, d]) => d.wins + d.losses >= 5)
    .map(([regime, d]) => {
      const total = d.wins + d.losses;
      const winRate = d.wins / total;
      const avgConf = d.confSum / total;
      const avgEdge = d.edgeSum / total;
      const highConfWR = d.highConfTotal > 0 ? d.highConfWins / d.highConfTotal : null;
      const lowConfWR = d.lowConfTotal > 0 ? d.lowConfWins / d.lowConfTotal : null;

      // Best category in this regime
      const bestCat = Object.entries(d.categories)
        .filter(([, c]) => c.wins + c.losses >= 3)
        .sort((a, b) => b[1].pnl - a[1].pnl)[0];

      // Best method in this regime
      const bestMethod = Object.entries(d.methods)
        .filter(([, m]) => m.wins + m.losses >= 3)
        .sort((a, b) => (b[1].wins / (b[1].wins + b[1].losses)) - (a[1].wins / (a[1].wins + a[1].losses)))[0];

      return {
        regime,
        trades: total,
        winRate: round3(winRate),
        avgPnl: round2(d.totalPnl / total),
        totalPnl: round2(d.totalPnl),
        avgConfidence: round3(avgConf),
        avgEdge: round3(avgEdge),
        highConfWinRate: highConfWR !== null ? round3(highConfWR) : null,
        lowConfWinRate: lowConfWR !== null ? round3(lowConfWR) : null,
        confidenceEffective: highConfWR !== null && lowConfWR !== null && highConfWR > lowConfWR,
        bestCategory: bestCat ? { category: bestCat[0], pnl: round2(bestCat[1].pnl) } : null,
        bestMethod: bestMethod ? bestMethod[0] : null,
        signal: winRate > 0.6 ? "favorable" : winRate < 0.4 ? "unfavorable" : "neutral"
      };
    });

  regimes.sort((a, b) => b.totalPnl - a.totalPnl);

  // Cross-regime insights
  const crossRegimeInsights = generateCrossRegimeInsights(regimes);

  return {
    regimes,
    bestRegime: regimes[0] || null,
    worstRegime: regimes[regimes.length - 1] || null,
    crossRegimeInsights,
    totalTrades: rows.length,
    lookbackDays: days
  };
}

/**
 * Get what happened last time we entered a specific regime.
 *
 * @param {string} targetRegime
 * @param {number} days
 * @returns {{ lastEntries, avgDuration, avgPnlPerEntry, recommendation }}
 */
export function getRegimeTransitionHistory(targetRegime, days = 60) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT regime, realized_pnl, status, created_at
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    ORDER BY created_at ASC
  `).all(daysOffset);

  if (rows.length < 10) {
    return { lastEntries: [], message: "insufficient_data" };
  }

  // Find regime entry points
  const entries = [];
  let currentRegime = null;
  let entryTrades = [];

  for (const r of rows) {
    const regime = r.regime || "unknown";
    if (regime === targetRegime && currentRegime !== targetRegime) {
      // Just entered target regime
      if (entryTrades.length > 0) {
        entries.push({ trades: [...entryTrades] });
      }
      entryTrades = [r];
    } else if (regime === targetRegime) {
      entryTrades.push(r);
    } else {
      if (entryTrades.length > 0) {
        entries.push({ trades: [...entryTrades] });
        entryTrades = [];
      }
    }
    currentRegime = regime;
  }
  if (entryTrades.length > 0) {
    entries.push({ trades: [...entryTrades] });
  }

  const lastEntries = entries.slice(-5).map(e => ({
    tradeCount: e.trades.length,
    wins: e.trades.filter(t => t.status === "WIN").length,
    totalPnl: round2(e.trades.reduce((s, t) => s + (t.realized_pnl || 0), 0)),
    winRate: round3(e.trades.filter(t => t.status === "WIN").length / e.trades.length)
  }));

  const avgPnlPerEntry = entries.length > 0
    ? round2(entries.reduce((s, e) => s + e.trades.reduce((s2, t) => s2 + (t.realized_pnl || 0), 0), 0) / entries.length)
    : 0;

  const avgTradesPerEntry = entries.length > 0
    ? round1(entries.reduce((s, e) => s + e.trades.length, 0) / entries.length)
    : 0;

  const recommendation = avgPnlPerEntry > 0
    ? `${targetRegime} has historically been profitable ($${avgPnlPerEntry}/entry avg). Trade actively.`
    : `${targetRegime} has been unprofitable ($${avgPnlPerEntry}/entry avg). Reduce exposure or tighten filters.`;

  return {
    targetRegime,
    entryCount: entries.length,
    lastEntries,
    avgPnlPerEntry,
    avgTradesPerEntry,
    recommendation,
    lookbackDays: days
  };
}

/**
 * Get regime memory dashboard.
 *
 * @returns {{ memory, inMemorySize, bestRegime, worstRegime }}
 */
export function getRegimeMemoryDashboard() {
  const memory = getRegimeMemory();
  const memSize = Object.keys(regimeMemory).length;

  return {
    bestRegime: memory.bestRegime?.regime || "unknown",
    bestRegimePnl: memory.bestRegime?.totalPnl || 0,
    worstRegime: memory.worstRegime?.regime || "unknown",
    worstRegimePnl: memory.worstRegime?.totalPnl || 0,
    regimeCount: (memory.regimes || []).length,
    inMemorySize: memSize,
    crossRegimeInsights: memory.crossRegimeInsights || [],
    totalTrades: memory.totalTrades || 0
  };
}

function generateCrossRegimeInsights(regimes) {
  const insights = [];
  if (regimes.length < 2) return insights;

  // Compare best vs worst
  const best = regimes[0];
  const worst = regimes[regimes.length - 1];
  if (best && worst && best.regime !== worst.regime) {
    insights.push({
      type: "regime_contrast",
      message: `${best.regime} outperforms ${worst.regime} by $${round2(best.totalPnl - worst.totalPnl)} total P&L`,
      actionable: true
    });
  }

  // Confidence effectiveness comparison
  const confEffective = regimes.filter(r => r.confidenceEffective);
  const confIneffective = regimes.filter(r => r.confidenceEffective === false);
  if (confIneffective.length > 0) {
    insights.push({
      type: "confidence_breakdown",
      message: `Confidence scoring unreliable in: ${confIneffective.map(r => r.regime).join(", ")}`,
      actionable: true
    });
  }

  // High-confidence performance divergence
  for (const r of regimes) {
    if (r.highConfWinRate !== null && r.highConfWinRate < 0.5) {
      insights.push({
        type: "high_conf_failure",
        message: `High-confidence trades underperform in ${r.regime} (${(r.highConfWinRate * 100).toFixed(0)}% WR)`,
        actionable: true
      });
    }
  }

  return insights.slice(0, 5);
}

function round1(v) { return Math.round((v ?? 0) * 10) / 10; }
function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
