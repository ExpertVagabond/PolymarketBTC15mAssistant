/**
 * Regime correlation tracker.
 *
 * Tracks how market regime changes propagate across categories:
 * - Which categories lead/lag regime shifts
 * - Regime desynchronization detection (crypto bullish + politics bearish)
 * - Category-level regime state mapping
 *
 * Uses trade execution data grouped by category and regime to compute
 * rolling correlation and detect divergence patterns.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Get regime correlations across categories.
 * Computes how similarly different categories behave in each regime.
 *
 * @param {number} days - lookback window
 * @returns {{ correlations: object[], categoryRegimes: object, divergences: object[] }}
 */
export function getRegimeCorrelations(days = 30) {
  const db = getDb();

  // Get per-category regime performance
  const rows = db.prepare(`
    SELECT category, regime,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      SUM(pnl_usd) as total_pnl,
      COUNT(*) as trades
    FROM trade_executions
    WHERE outcome IN ('WIN', 'LOSS') AND created_at > datetime('now', ?)
    GROUP BY category, regime
  `).all(`-${days} days`);

  if (rows.length < 4) {
    return { correlations: [], categoryRegimes: {}, divergences: [], insufficient: true, sampleSize: rows.length };
  }

  // Build category regime map: category -> { regime -> { winRate, pnl, trades } }
  const categoryRegimes = {};
  for (const r of rows) {
    const cat = r.category || "unknown";
    if (!categoryRegimes[cat]) categoryRegimes[cat] = {};
    const total = r.wins + r.losses;
    categoryRegimes[cat][r.regime || "RANGE"] = {
      winRate: total > 0 ? Math.round((r.wins / total) * 1000) / 10 : 0,
      pnl: Math.round((r.total_pnl || 0) * 100) / 100,
      trades: total
    };
  }

  // Compute pairwise correlations between categories
  const categories = Object.keys(categoryRegimes).filter(c => {
    const totalTrades = Object.values(categoryRegimes[c]).reduce((s, r) => s + r.trades, 0);
    return totalTrades >= 5;
  });

  const correlations = [];
  const regimes = ["TREND_UP", "TREND_DOWN", "RANGE", "CHOP"];

  for (let i = 0; i < categories.length; i++) {
    for (let j = i + 1; j < categories.length; j++) {
      const cat1 = categories[i];
      const cat2 = categories[j];

      // Build win rate vectors across regimes
      const vec1 = regimes.map(r => categoryRegimes[cat1]?.[r]?.winRate ?? 50);
      const vec2 = regimes.map(r => categoryRegimes[cat2]?.[r]?.winRate ?? 50);

      const corr = pearsonCorr(vec1, vec2);
      correlations.push({
        category1: cat1,
        category2: cat2,
        correlation: Math.round(corr * 1000) / 1000,
        aligned: corr > 0.5,
        divergent: corr < -0.3
      });
    }
  }

  correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  return { correlations, categoryRegimes, divergences: [], days, categories: categories.length };
}

/**
 * Detect regime divergence: categories behaving opposite to expectations.
 * @param {number} days
 * @returns {{ divergences: object[], overallAlignment: number }}
 */
export function detectRegimeDivergence(days = 14) {
  const db = getDb();

  // Get current regime from most recent signal
  const latestRegime = db.prepare(`
    SELECT regime FROM signal_history WHERE regime IS NOT NULL ORDER BY id DESC LIMIT 1
  `).get();
  const currentRegime = latestRegime?.regime || "RANGE";

  // Expected behavior per regime
  const regimeExpectation = {
    TREND_UP: { expectedWinRate: 55, label: "bullish" },
    TREND_DOWN: { expectedWinRate: 45, label: "bearish" },
    RANGE: { expectedWinRate: 50, label: "neutral" },
    CHOP: { expectedWinRate: 40, label: "uncertain" }
  };

  const expectedWR = regimeExpectation[currentRegime]?.expectedWinRate || 50;

  // Get recent per-category win rates (last N days in current regime)
  const catRows = db.prepare(`
    SELECT category,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses
    FROM trade_executions
    WHERE outcome IN ('WIN', 'LOSS') AND regime = ?
      AND created_at > datetime('now', ?)
    GROUP BY category
    HAVING (wins + losses) >= 3
  `).all(currentRegime, `-${days} days`);

  const divergences = [];
  let alignedCount = 0;

  for (const r of catRows) {
    const total = r.wins + r.losses;
    const winRate = Math.round((r.wins / total) * 1000) / 10;
    const deviation = winRate - expectedWR;

    if (Math.abs(deviation) > 15) {
      divergences.push({
        category: r.category || "unknown",
        winRate,
        expectedWinRate: expectedWR,
        deviation: Math.round(deviation * 10) / 10,
        direction: deviation > 0 ? "outperforming" : "underperforming",
        trades: total,
        severity: Math.abs(deviation) > 25 ? "high" : "moderate"
      });
    } else {
      alignedCount++;
    }
  }

  divergences.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));

  const totalCats = catRows.length;
  const overallAlignment = totalCats > 0 ? Math.round((alignedCount / totalCats) * 100) : 100;

  return {
    currentRegime,
    expectedWinRate: expectedWR,
    divergences,
    overallAlignment,
    alignedCategories: alignedCount,
    totalCategories: totalCats,
    days
  };
}

/**
 * Get category-level regime state map.
 * @param {number} days
 * @returns {object}
 */
export function getCategoryRegimeMap(days = 30) {
  const { categoryRegimes, categories } = getRegimeCorrelations(days);

  // For each category, determine its "dominant" regime (best win rate)
  const map = {};
  for (const [cat, regimes] of Object.entries(categoryRegimes)) {
    let bestRegime = "RANGE";
    let bestWR = 0;
    let totalTrades = 0;

    for (const [regime, data] of Object.entries(regimes)) {
      totalTrades += data.trades;
      if (data.trades >= 3 && data.winRate > bestWR) {
        bestWR = data.winRate;
        bestRegime = regime;
      }
    }

    map[cat] = {
      bestRegime,
      bestWinRate: bestWR,
      totalTrades,
      regimeBreakdown: regimes
    };
  }

  return { categoryMap: map, categories, days };
}

function pearsonCorr(x, y) {
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
