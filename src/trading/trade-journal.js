/**
 * Trade journal & pattern recognition.
 *
 * Automatic journaling of every trade with:
 * - Entry reasons: which signals triggered the trade
 * - Exit triggers: what caused the exit (target, stop, timeout, manual)
 * - Post-mortem tags: categorize outcomes (good-entry-bad-exit, etc.)
 * - Pattern clustering: group winning/losing setups by features
 * - Regime-specific patterns: discover what works in each regime
 *
 * Enables root cause analysis of drawdowns and discovery of
 * high-edge recurring patterns.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Generate trade journal entries from recent execution history.
 * Automatically tags and categorizes each trade.
 *
 * @param {number} days - Lookback period
 * @param {number} limit - Max entries
 * @returns {{ entries: object[], summary: object }}
 */
export function getTradeJournal(days = 14, limit = 100) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT id, market_id, side, entry_price, exit_price,
           confidence, edge_at_entry, quality_score,
           regime, category, sizing_method,
           realized_pnl, slippage_bps, status,
           created_at, filled_at, closed_at
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS', 'CLOSED')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(daysOffset, Math.min(limit, 500));

  const entries = rows.map(r => {
    const pnl = r.realized_pnl ?? 0;
    const isWin = r.status === "WIN" || pnl > 0;

    // Entry quality assessment
    const entryQuality = assessEntryQuality(r);
    // Exit quality assessment
    const exitQuality = assessExitQuality(r);
    // Post-mortem tag
    const postMortem = getPostMortemTag(entryQuality, exitQuality, isWin);
    // Pattern signature
    const pattern = getPatternSignature(r);

    return {
      id: r.id,
      marketId: r.market_id,
      side: r.side,
      regime: r.regime,
      category: r.category,
      confidence: r.confidence,
      edge: r.edge_at_entry,
      quality: r.quality_score,
      pnl: Math.round(pnl * 100) / 100,
      slippageBps: r.slippage_bps ?? 0,
      status: r.status,
      entryQuality,
      exitQuality,
      postMortem,
      pattern,
      createdAt: r.created_at
    };
  });

  // Summary statistics
  const tags = {};
  const patterns = {};
  for (const e of entries) {
    tags[e.postMortem] = (tags[e.postMortem] || 0) + 1;
    patterns[e.pattern] = patterns[e.pattern] || { count: 0, wins: 0, totalPnl: 0 };
    patterns[e.pattern].count++;
    if (e.status === "WIN") patterns[e.pattern].wins++;
    patterns[e.pattern].totalPnl += e.pnl;
  }

  // Rank patterns by frequency and win rate
  const patternRanking = Object.entries(patterns)
    .map(([pat, d]) => ({
      pattern: pat,
      count: d.count,
      winRate: Math.round(d.wins / d.count * 1000) / 1000,
      avgPnl: Math.round(d.totalPnl / d.count * 100) / 100
    }))
    .sort((a, b) => b.count - a.count);

  return {
    entries: entries.slice(0, 50),
    summary: {
      totalEntries: entries.length,
      wins: entries.filter(e => e.status === "WIN").length,
      losses: entries.filter(e => e.status === "LOSS").length,
      avgPnl: entries.length > 0
        ? Math.round(entries.reduce((s, e) => s + e.pnl, 0) / entries.length * 100) / 100 : 0,
      postMortemTags: tags,
      topPatterns: patternRanking.slice(0, 10)
    }
  };
}

/**
 * Discover winning and losing patterns.
 * Clusters trades by feature combinations to find recurring setups.
 *
 * @param {number} days - Lookback period
 * @returns {{ winningPatterns: object[], losingPatterns: object[], insights: string[] }}
 */
export function discoverPatterns(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT regime, category, side, sizing_method,
           confidence, quality_score, edge_at_entry,
           realized_pnl, status
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    ORDER BY created_at DESC
  `).all(daysOffset);

  if (rows.length < 10) {
    return { winningPatterns: [], losingPatterns: [], insights: ["Insufficient data for pattern discovery."] };
  }

  // Cluster by regime × category × confidence_bucket
  const clusters = {};
  for (const r of rows) {
    const confBucket = r.confidence >= 0.8 ? "high_conf"
      : r.confidence >= 0.6 ? "mid_conf" : "low_conf";
    const qualBucket = (r.quality_score ?? 50) >= 70 ? "high_qual"
      : (r.quality_score ?? 50) >= 40 ? "mid_qual" : "low_qual";

    const key = `${r.regime || "?"}|${r.category || "?"}|${confBucket}|${qualBucket}`;
    if (!clusters[key]) clusters[key] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
    clusters[key].count++;
    clusters[key].totalPnl += r.realized_pnl ?? 0;
    if (r.status === "WIN") clusters[key].wins++;
    else clusters[key].losses++;
  }

  // Convert to ranked lists
  const allPatterns = Object.entries(clusters)
    .filter(([, d]) => d.count >= 3)
    .map(([key, d]) => {
      const [regime, category, conf, qual] = key.split("|");
      return {
        regime, category, confidence: conf, quality: qual,
        count: d.count,
        winRate: Math.round(d.wins / d.count * 1000) / 1000,
        avgPnl: Math.round(d.totalPnl / d.count * 100) / 100,
        totalPnl: Math.round(d.totalPnl * 100) / 100
      };
    });

  const winningPatterns = allPatterns
    .filter(p => p.winRate >= 0.6 && p.count >= 3)
    .sort((a, b) => b.avgPnl - a.avgPnl)
    .slice(0, 10);

  const losingPatterns = allPatterns
    .filter(p => p.winRate < 0.4 && p.count >= 3)
    .sort((a, b) => a.avgPnl - b.avgPnl)
    .slice(0, 10);

  // Generate insights
  const insights = [];

  if (winningPatterns.length > 0) {
    const best = winningPatterns[0];
    insights.push(`Best pattern: ${best.regime} + ${best.category} + ${best.confidence} (${(best.winRate * 100).toFixed(0)}% WR, ${best.count} trades)`);
  }

  if (losingPatterns.length > 0) {
    const worst = losingPatterns[0];
    insights.push(`Worst pattern: ${worst.regime} + ${worst.category} + ${worst.confidence} (${(worst.winRate * 100).toFixed(0)}% WR, ${worst.count} trades) — consider blocking`);
  }

  // Regime-specific insight
  const byRegime = {};
  for (const r of rows) {
    const key = r.regime || "unknown";
    if (!byRegime[key]) byRegime[key] = { wins: 0, total: 0 };
    byRegime[key].total++;
    if (r.status === "WIN") byRegime[key].wins++;
  }
  const regimeRanking = Object.entries(byRegime)
    .map(([r, d]) => ({ regime: r, winRate: d.wins / d.total, count: d.total }))
    .sort((a, b) => b.winRate - a.winRate);

  if (regimeRanking.length >= 2) {
    const best = regimeRanking[0];
    const worst = regimeRanking[regimeRanking.length - 1];
    insights.push(`Best regime: ${best.regime} (${(best.winRate * 100).toFixed(0)}% WR). Worst: ${worst.regime} (${(worst.winRate * 100).toFixed(0)}% WR)`);
  }

  return { winningPatterns, losingPatterns, insights };
}

/**
 * Get drawdown root cause analysis.
 * Identifies what went wrong during losing streaks.
 *
 * @param {number} days - Lookback period
 * @returns {{ streaks: object[], rootCauses: object[] }}
 */
export function getDrawdownAnalysis(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT id, regime, category, confidence, quality_score,
           realized_pnl, status, created_at
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    ORDER BY created_at ASC
  `).all(daysOffset);

  if (rows.length < 5) {
    return { streaks: [], rootCauses: [] };
  }

  // Find losing streaks (3+ consecutive losses)
  const streaks = [];
  let currentStreak = [];

  for (const r of rows) {
    if (r.status === "LOSS") {
      currentStreak.push(r);
    } else {
      if (currentStreak.length >= 3) {
        streaks.push(analyzeStreak(currentStreak));
      }
      currentStreak = [];
    }
  }
  if (currentStreak.length >= 3) {
    streaks.push(analyzeStreak(currentStreak));
  }

  // Root cause aggregation
  const causes = {};
  for (const streak of streaks) {
    for (const cause of streak.likelyCauses) {
      causes[cause] = (causes[cause] || 0) + 1;
    }
  }

  const rootCauses = Object.entries(causes)
    .map(([cause, count]) => ({ cause, occurrences: count }))
    .sort((a, b) => b.occurrences - a.occurrences);

  return {
    streaks: streaks.sort((a, b) => b.length - a.length).slice(0, 10),
    rootCauses,
    totalLosingStreaks: streaks.length,
    longestStreak: streaks.length > 0 ? Math.max(...streaks.map(s => s.length)) : 0,
    avgStreakLength: streaks.length > 0
      ? Math.round(streaks.reduce((s, st) => s + st.length, 0) / streaks.length * 10) / 10 : 0
  };
}

// Helper functions

function assessEntryQuality(trade) {
  const conf = trade.confidence ?? 0.5;
  const edge = trade.edge_at_entry ?? 0;
  const qual = trade.quality_score ?? 50;

  if (conf >= 0.75 && edge >= 0.05 && qual >= 60) return "strong";
  if (conf >= 0.6 && edge >= 0.02) return "adequate";
  if (conf < 0.5 || edge < 0) return "weak";
  return "marginal";
}

function assessExitQuality(trade) {
  const pnl = trade.realized_pnl ?? 0;
  const slip = Math.abs(trade.slippage_bps ?? 0);

  if (pnl > 0 && slip < 10) return "clean_win";
  if (pnl > 0 && slip >= 10) return "sloppy_win";
  if (pnl <= 0 && slip < 10) return "clean_loss";
  return "sloppy_loss";
}

function getPostMortemTag(entry, exit, isWin) {
  if (entry === "strong" && isWin) return "textbook";
  if (entry === "strong" && !isWin) return "good_entry_bad_outcome";
  if (entry === "weak" && isWin) return "lucky";
  if (entry === "weak" && !isWin) return "avoidable";
  if (entry === "marginal" && !isWin) return "marginal_loss";
  if (exit.includes("sloppy")) return "execution_issue";
  return isWin ? "standard_win" : "standard_loss";
}

function getPatternSignature(trade) {
  const regime = trade.regime || "?";
  const cat = trade.category || "?";
  const confLevel = (trade.confidence ?? 0.5) >= 0.7 ? "HC" : (trade.confidence ?? 0.5) >= 0.5 ? "MC" : "LC";
  return `${regime}_${cat}_${confLevel}`;
}

function analyzeStreak(trades) {
  const regimes = trades.map(t => t.regime).filter(Boolean);
  const categories = trades.map(t => t.category).filter(Boolean);
  const avgConf = trades.reduce((s, t) => s + (t.confidence ?? 0.5), 0) / trades.length;
  const totalLoss = trades.reduce((s, t) => s + (t.realized_pnl ?? 0), 0);

  // Determine likely causes
  const causes = [];
  const uniqueRegimes = [...new Set(regimes)];
  if (uniqueRegimes.length === 1 && uniqueRegimes[0] === "CHOP") causes.push("chop_regime");
  if (avgConf < 0.55) causes.push("low_confidence_entries");
  if (new Set(categories).size === 1) causes.push("category_concentration");
  if (trades.length >= 5) causes.push("overtrading");
  if (causes.length === 0) causes.push("market_conditions");

  return {
    length: trades.length,
    totalLoss: Math.round(totalLoss * 100) / 100,
    avgConfidence: Math.round(avgConf * 1000) / 1000,
    dominantRegime: mode(regimes),
    dominantCategory: mode(categories),
    likelyCauses: causes,
    startDate: trades[0].created_at,
    endDate: trades[trades.length - 1].created_at
  };
}

function mode(arr) {
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || "unknown";
}
