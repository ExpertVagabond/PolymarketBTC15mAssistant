/**
 * Strategy meta-selector with cross-category lead-lag detection.
 *
 * Intelligently selects which strategies to run based on:
 * - Regime-to-strategy performance mapping
 * - Dynamic strategy mix allocation by regime forecast
 * - Cross-category lead-lag relationships (crypto leads politics, etc.)
 * - Strategy rotation recommendations based on regime transitions
 *
 * Answers: "Given current regime and category signals, which
 * strategies should we emphasize and which should we bench?"
 */

import { getDb } from "../subscribers/db.js";

/**
 * Get optimal strategy allocation for current conditions.
 *
 * @param {object} opts
 * @param {string} opts.currentRegime
 * @param {number} opts.days - Lookback for performance data
 * @returns {{ recommended, regimeMap, allocation }}
 */
export function getStrategyAllocation(opts = {}) {
  const db = getDb();
  const regime = opts.currentRegime || "RANGE";
  const days = Math.min(opts.days || 30, 180);
  const daysOffset = `-${days} days`;

  // Get strategy performance by regime
  const rows = db.prepare(`
    SELECT regime, sizing_method, status, realized_pnl,
           confidence, quality_score
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 10) {
    return { recommended: [], regimeMap: {}, allocation: {}, message: "insufficient_data" };
  }

  // Build regime × strategy performance matrix
  const matrix = {};
  for (const r of rows) {
    const reg = r.regime || "unknown";
    const strat = r.sizing_method || "default";
    const key = `${reg}|${strat}`;

    if (!matrix[key]) matrix[key] = { wins: 0, losses: 0, pnl: 0, count: 0 };
    matrix[key].count++;
    matrix[key].pnl += r.realized_pnl;
    if (r.status === "WIN") matrix[key].wins++;
    else matrix[key].losses++;
  }

  // Strategy performance for current regime
  const currentRegimeStrats = {};
  for (const [key, data] of Object.entries(matrix)) {
    const [reg, strat] = key.split("|");
    if (reg !== regime) continue;
    currentRegimeStrats[strat] = {
      winRate: round3(data.wins / data.count),
      avgPnl: round2(data.pnl / data.count),
      trades: data.count,
      sharpeProxy: round2(data.pnl / data.count / (stddev(rows.filter(r => r.regime === regime && r.sizing_method === strat).map(r => r.realized_pnl)) || 1))
    };
  }

  // Rank strategies for current regime
  const ranked = Object.entries(currentRegimeStrats)
    .map(([strat, perf]) => ({ strategy: strat, ...perf }))
    .filter(s => s.trades >= 3)
    .sort((a, b) => b.sharpeProxy - a.sharpeProxy);

  // Allocation: inverse-risk weighting of top strategies
  const topN = ranked.slice(0, 5);
  const totalSharpe = topN.reduce((s, t) => s + Math.max(0.01, t.sharpeProxy), 0);
  const allocation = {};
  for (const s of topN) {
    allocation[s.strategy] = round3(Math.max(0.01, s.sharpeProxy) / totalSharpe);
  }

  // Full regime map
  const regimeMap = {};
  for (const [key, data] of Object.entries(matrix)) {
    const [reg, strat] = key.split("|");
    if (!regimeMap[reg]) regimeMap[reg] = [];
    regimeMap[reg].push({
      strategy: strat,
      winRate: round3(data.wins / data.count),
      avgPnl: round2(data.pnl / data.count),
      trades: data.count
    });
  }
  for (const reg of Object.keys(regimeMap)) {
    regimeMap[reg].sort((a, b) => b.avgPnl - a.avgPnl);
  }

  return {
    currentRegime: regime,
    recommended: ranked.slice(0, 3).map(s => s.strategy),
    benched: ranked.filter(s => s.winRate < 0.4 || s.avgPnl < 0).map(s => s.strategy),
    allocation,
    strategyPerformance: ranked,
    regimeMap,
    totalTrades: rows.length
  };
}

/**
 * Detect cross-category lead-lag relationships.
 * Identifies which categories' price moves predict others.
 *
 * @param {number} days - Lookback
 * @returns {{ pairs: object[], insights: string[] }}
 */
export function detectLeadLag(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  // Get hourly win rates by category
  const rows = db.prepare(`
    SELECT category,
           strftime('%Y-%m-%d %H', created_at) as hour_bucket,
           AVG(CASE WHEN status = 'WIN' THEN 1.0 ELSE 0.0 END) as win_rate,
           COUNT(*) as trades
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    GROUP BY category, hour_bucket
    HAVING COUNT(*) >= 2
    ORDER BY hour_bucket
  `).all(daysOffset);

  // Build time series per category
  const series = {};
  for (const r of rows) {
    const cat = r.category || "unknown";
    if (!series[cat]) series[cat] = {};
    series[cat][r.hour_bucket] = r.win_rate;
  }

  const categories = Object.keys(series).filter(c => Object.keys(series[c]).length >= 5);
  if (categories.length < 2) {
    return { pairs: [], insights: ["Insufficient category data for lead-lag analysis."] };
  }

  // Compute lagged correlations between all pairs
  const pairs = [];
  for (let i = 0; i < categories.length; i++) {
    for (let j = i + 1; j < categories.length; j++) {
      const catA = categories[i];
      const catB = categories[j];

      // Get aligned time buckets
      const allBuckets = [...new Set([...Object.keys(series[catA]), ...Object.keys(series[catB])])].sort();

      // Lag 0 correlation
      const lag0 = computeCorrelation(series[catA], series[catB], allBuckets, 0);
      // Lag 1 (A leads B by 1 hour)
      const lag1AB = computeCorrelation(series[catA], series[catB], allBuckets, 1);
      // Lag 1 (B leads A by 1 hour)
      const lag1BA = computeCorrelation(series[catB], series[catA], allBuckets, 1);

      const maxLag = Math.max(Math.abs(lag1AB), Math.abs(lag1BA));
      if (maxLag > 0.3) {
        const leader = Math.abs(lag1AB) > Math.abs(lag1BA) ? catA : catB;
        const follower = leader === catA ? catB : catA;
        const lagCorr = leader === catA ? lag1AB : lag1BA;

        pairs.push({
          leader,
          follower,
          contemporaneousCorr: round3(lag0),
          laggedCorr: round3(lagCorr),
          lagHours: 1,
          relationship: lagCorr > 0 ? "positive_lead" : "negative_lead",
          strength: Math.abs(lagCorr) > 0.6 ? "strong" : "moderate"
        });
      }
    }
  }

  pairs.sort((a, b) => Math.abs(b.laggedCorr) - Math.abs(a.laggedCorr));

  // Generate insights
  const insights = [];
  if (pairs.length > 0) {
    const top = pairs[0];
    insights.push(`${top.leader} leads ${top.follower} by ~1 hour (r=${top.laggedCorr})`);
  }
  if (pairs.filter(p => p.strength === "strong").length > 2) {
    insights.push("Multiple strong lead-lag relationships detected — consider cross-category signal propagation.");
  }
  if (pairs.length === 0) {
    insights.push("No significant lead-lag relationships found in current data.");
  }

  return {
    pairs: pairs.slice(0, 15),
    insights,
    categoriesAnalyzed: categories.length,
    pairsChecked: categories.length * (categories.length - 1) / 2
  };
}

/**
 * Get strategy rotation recommendations.
 * Based on regime forecast and lead-lag signals.
 *
 * @param {object} opts
 * @param {string} opts.currentRegime
 * @param {string} opts.forecastRegime - Predicted next regime
 * @returns {{ rotations: object[], urgency: string }}
 */
export function getRotationRecommendations(opts = {}) {
  const current = getStrategyAllocation({ currentRegime: opts.currentRegime || "RANGE" });
  const forecast = getStrategyAllocation({ currentRegime: opts.forecastRegime || opts.currentRegime || "RANGE" });

  const rotations = [];

  // Compare current vs forecast allocations
  const allStrats = new Set([
    ...Object.keys(current.allocation || {}),
    ...Object.keys(forecast.allocation || {})
  ]);

  for (const strat of allStrats) {
    const currentPct = current.allocation[strat] || 0;
    const forecastPct = forecast.allocation[strat] || 0;
    const delta = forecastPct - currentPct;

    if (Math.abs(delta) > 0.1) {
      rotations.push({
        strategy: strat,
        currentAllocation: round3(currentPct),
        targetAllocation: round3(forecastPct),
        action: delta > 0 ? "increase" : "decrease",
        magnitude: round3(Math.abs(delta))
      });
    }
  }

  rotations.sort((a, b) => b.magnitude - a.magnitude);

  const urgency = opts.currentRegime !== opts.forecastRegime ? "high" : "low";

  return {
    currentRegime: opts.currentRegime || "RANGE",
    forecastRegime: opts.forecastRegime || opts.currentRegime || "RANGE",
    regimeChanging: opts.currentRegime !== opts.forecastRegime,
    rotations,
    urgency,
    recommendation: rotations.length > 0
      ? `${rotations.length} strategy adjustments needed for ${opts.forecastRegime || "forecast"} regime.`
      : "No rotation needed — current allocation matches forecast."
  };
}

// Helpers

function computeCorrelation(seriesA, seriesB, buckets, lag) {
  const pairs = [];
  for (let i = lag; i < buckets.length; i++) {
    const a = seriesA[buckets[i - lag]];
    const b = seriesB[buckets[i]];
    if (a !== undefined && b !== undefined) pairs.push([a, b]);
  }
  if (pairs.length < 3) return 0;

  const meanA = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const meanB = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let num = 0, denA = 0, denB = 0;
  for (const [a, b] of pairs) {
    num += (a - meanA) * (b - meanB);
    denA += (a - meanA) ** 2;
    denB += (b - meanB) ** 2;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
function stddev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}
