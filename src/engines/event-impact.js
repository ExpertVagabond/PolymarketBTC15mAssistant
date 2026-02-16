/**
 * Event impact modeler.
 *
 * Models settlement pattern impacts from historical data:
 * - Time-of-day and day-of-week performance profiles
 * - Pre-settlement volatility clustering
 * - Category-specific event patterns
 * - Settlement proximity impact on signal quality
 * - Historical pattern matching for similar market conditions
 *
 * All analysis is from observable trade data — no external APIs.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Get time-of-day performance profile.
 * Identifies which hours produce best/worst outcomes.
 *
 * @param {number} days - Lookback
 * @returns {{ hourly, bestHours, worstHours, timezone }}
 */
export function getTimeOfDayProfile(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour,
           COUNT(*) as trades,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
           SUM(realized_pnl) as total_pnl,
           AVG(realized_pnl) as avg_pnl,
           AVG(confidence) as avg_conf
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY hour
    ORDER BY hour
  `).all(daysOffset);

  if (rows.length === 0) {
    return { hourly: [], bestHours: [], worstHours: [], message: "no_data" };
  }

  const hourly = rows.map(r => ({
    hour: r.hour,
    trades: r.trades,
    winRate: round3(r.wins / r.trades),
    avgPnl: round2(r.avg_pnl),
    totalPnl: round2(r.total_pnl),
    avgConfidence: round3(r.avg_conf || 0),
    sharpeProxy: round2(r.avg_pnl / (stddevFromRows(rows, r.hour) || 1))
  }));

  hourly.sort((a, b) => b.avgPnl - a.avgPnl);
  const bestHours = hourly.filter(h => h.avgPnl > 0 && h.trades >= 3).slice(0, 3).map(h => h.hour);
  const worstHours = hourly.filter(h => h.avgPnl < 0 && h.trades >= 3).slice(-3).map(h => h.hour);

  // Re-sort by hour for display
  hourly.sort((a, b) => a.hour - b.hour);

  return {
    hourly,
    bestHours,
    worstHours,
    timezone: "UTC",
    lookbackDays: days,
    totalTrades: rows.reduce((s, r) => s + r.trades, 0)
  };
}

/**
 * Get day-of-week performance profile.
 *
 * @param {number} days
 * @returns {{ daily, bestDays, worstDays }}
 */
export function getDayOfWeekProfile(days = 60) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const rows = db.prepare(`
    SELECT CAST(strftime('%w', created_at) AS INTEGER) as dow,
           COUNT(*) as trades,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
           SUM(realized_pnl) as total_pnl,
           AVG(realized_pnl) as avg_pnl
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY dow
    ORDER BY dow
  `).all(daysOffset);

  const daily = rows.map(r => ({
    day: dayNames[r.dow] || `Day ${r.dow}`,
    dayNum: r.dow,
    trades: r.trades,
    winRate: round3(r.wins / r.trades),
    avgPnl: round2(r.avg_pnl),
    totalPnl: round2(r.total_pnl)
  }));

  daily.sort((a, b) => b.avgPnl - a.avgPnl);
  const bestDays = daily.filter(d => d.avgPnl > 0 && d.trades >= 3).slice(0, 2).map(d => d.day);
  const worstDays = daily.filter(d => d.avgPnl < 0 && d.trades >= 3).slice(-2).map(d => d.day);

  daily.sort((a, b) => a.dayNum - b.dayNum);

  return { daily, bestDays, worstDays, lookbackDays: days };
}

/**
 * Analyze pre-settlement volatility clustering.
 * Measures how signal quality and volatility change as settlement approaches.
 *
 * @param {number} days
 * @returns {{ buckets, pattern, recommendation }}
 */
export function getSettlementProximityImpact(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  // Use confidence and quality as proxies for proximity behavior
  const rows = db.prepare(`
    SELECT confidence, quality_score, edge_at_entry, realized_pnl,
           status, regime, category,
           CAST(strftime('%H', created_at) AS INTEGER) as hour
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    ORDER BY created_at
  `).all(daysOffset);

  if (rows.length < 10) {
    return { buckets: [], pattern: "unknown", message: "insufficient_data" };
  }

  // Bucket by confidence quartiles (proxy for market maturity/settlement proximity)
  const confBuckets = [
    { name: "low_conf", min: 0, max: 0.5 },
    { name: "mid_conf", min: 0.5, max: 0.65 },
    { name: "high_conf", min: 0.65, max: 0.8 },
    { name: "very_high_conf", min: 0.8, max: 1.01 }
  ];

  const buckets = confBuckets.map(b => {
    const filtered = rows.filter(r => (r.confidence || 0) >= b.min && (r.confidence || 0) < b.max);
    if (filtered.length === 0) return { name: b.name, trades: 0 };

    const wins = filtered.filter(r => r.status === "WIN").length;
    const pnls = filtered.map(r => r.realized_pnl);

    return {
      name: b.name,
      confRange: `${b.min}-${b.max}`,
      trades: filtered.length,
      winRate: round3(wins / filtered.length),
      avgPnl: round2(avg(pnls)),
      volatility: round3(stddev(pnls)),
      sharpe: round2(avg(pnls) / (stddev(pnls) || 1))
    };
  }).filter(b => b.trades > 0);

  // Detect pattern: does higher confidence = better outcomes?
  const sharpes = buckets.map(b => b.sharpe || 0);
  let monotonic = true;
  for (let i = 1; i < sharpes.length; i++) {
    if (sharpes[i] < sharpes[i - 1] - 0.1) monotonic = false;
  }

  const pattern = monotonic ? "confidence_calibrated" : "confidence_miscalibrated";

  return {
    buckets,
    pattern,
    recommendation: monotonic
      ? "Confidence scoring is well-calibrated — trust higher confidence trades"
      : "Confidence not predictive of outcomes — recalibrate or reduce reliance",
    lookbackDays: days
  };
}

/**
 * Get category-specific event patterns.
 *
 * @param {number} days
 * @returns {{ categories, crossCategoryInsights }}
 */
export function getCategoryEventPatterns(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT category, regime,
           CAST(strftime('%H', created_at) AS INTEGER) as hour,
           CAST(strftime('%w', created_at) AS INTEGER) as dow,
           COUNT(*) as trades,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
           SUM(realized_pnl) as total_pnl,
           AVG(realized_pnl) as avg_pnl,
           AVG(confidence) as avg_conf
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY category, regime
    ORDER BY category
  `).all(daysOffset);

  if (rows.length === 0) {
    return { categories: [], crossCategoryInsights: [] };
  }

  // Group by category
  const byCategory = {};
  for (const r of rows) {
    const cat = r.category || "unknown";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(r);
  }

  const categories = Object.entries(byCategory).map(([cat, data]) => {
    const totalTrades = data.reduce((s, r) => s + r.trades, 0);
    const totalWins = data.reduce((s, r) => s + r.wins, 0);
    const totalPnl = data.reduce((s, r) => s + r.total_pnl, 0);

    // Best regime for this category
    const regimePerf = data.map(r => ({
      regime: r.regime || "unknown",
      winRate: round3(r.wins / r.trades),
      avgPnl: round2(r.avg_pnl),
      trades: r.trades
    })).filter(r => r.trades >= 3);
    regimePerf.sort((a, b) => b.avgPnl - a.avgPnl);

    return {
      category: cat,
      trades: totalTrades,
      winRate: round3(totalWins / totalTrades),
      avgPnl: round2(totalPnl / totalTrades),
      totalPnl: round2(totalPnl),
      bestRegime: regimePerf[0] || null,
      worstRegime: regimePerf[regimePerf.length - 1] || null,
      regimeBreakdown: regimePerf.slice(0, 4)
    };
  });

  categories.sort((a, b) => b.avgPnl - a.avgPnl);

  // Cross-category insights
  const insights = [];
  if (categories.length >= 2) {
    const best = categories[0];
    const worst = categories[categories.length - 1];
    if (best.avgPnl > 0 && worst.avgPnl < 0) {
      insights.push(`${best.category} outperforms ${worst.category} by $${round2(best.avgPnl - worst.avgPnl)}/trade`);
    }
  }
  const chopCats = categories.filter(c => c.worstRegime?.regime === "CHOP");
  if (chopCats.length > categories.length / 2) {
    insights.push("Most categories struggle in CHOP regime — consider reducing exposure during chop");
  }

  return {
    categories,
    crossCategoryInsights: insights,
    lookbackDays: days
  };
}

/**
 * Get historical pattern matching for current conditions.
 * Finds past periods with similar regime/vol/category mix and reports outcomes.
 *
 * @param {object} current
 * @param {string} current.regime
 * @param {string} current.category
 * @param {number} current.confidence
 * @param {number} days
 * @returns {{ matches, expectedOutcome, sampleSize }}
 */
export function matchHistoricalPatterns(current = {}, days = 60) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const regime = current.regime || "RANGE";
  const category = current.category || "%";
  const confMin = (current.confidence || 0.5) - 0.1;
  const confMax = (current.confidence || 0.5) + 0.1;

  const rows = db.prepare(`
    SELECT realized_pnl, status, confidence, quality_score, regime, category
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    AND regime = ?
    AND category LIKE ?
    AND confidence BETWEEN ? AND ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(daysOffset, regime, category, confMin, confMax);

  if (rows.length < 5) {
    return { matches: 0, expectedOutcome: null, message: "insufficient_matches" };
  }

  const wins = rows.filter(r => r.status === "WIN").length;
  const pnls = rows.map(r => r.realized_pnl);

  return {
    matches: rows.length,
    regime,
    category: current.category || "all",
    confidenceRange: `${round3(confMin)}-${round3(confMax)}`,
    expectedOutcome: {
      winRate: round3(wins / rows.length),
      avgPnl: round2(avg(pnls)),
      medianPnl: round2(median(pnls)),
      stdPnl: round2(stddev(pnls)),
      bestCase: round2(Math.max(...pnls)),
      worstCase: round2(Math.min(...pnls))
    },
    recommendation: wins / rows.length > 0.55
      ? "Historical pattern favorable — proceed with normal sizing"
      : wins / rows.length < 0.45
        ? "Historical pattern unfavorable — reduce size or skip"
        : "Historical pattern neutral — use other signals for decision"
  };
}

/**
 * Get full event impact overview.
 *
 * @param {number} days
 * @returns {{ timeOfDay, dayOfWeek, settlement, categories }}
 */
export function getEventImpactOverview(days = 30) {
  const tod = getTimeOfDayProfile(days);
  const dow = getDayOfWeekProfile(days);
  const settlement = getSettlementProximityImpact(days);
  const categories = getCategoryEventPatterns(days);

  return {
    timeOfDay: {
      bestHours: tod.bestHours,
      worstHours: tod.worstHours,
      totalTrades: tod.totalTrades || 0
    },
    dayOfWeek: {
      bestDays: dow.bestDays,
      worstDays: dow.worstDays
    },
    settlementPattern: settlement.pattern,
    topCategory: categories.categories[0]?.category || "unknown",
    insights: [
      ...(tod.bestHours.length > 0 ? [`Best hours (UTC): ${tod.bestHours.join(", ")}`] : []),
      ...(dow.bestDays.length > 0 ? [`Best days: ${dow.bestDays.join(", ")}`] : []),
      ...(settlement.recommendation ? [settlement.recommendation] : []),
      ...categories.crossCategoryInsights
    ]
  };
}

// Helpers

function avg(arr) { return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(arr) {
  if (arr.length === 0) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function stddevFromRows(allRows, targetHour) {
  const pnls = allRows.filter(r => r.hour === targetHour);
  if (pnls.length === 0) return 1;
  // Use total_pnl / trades as proxy
  const values = pnls.map(r => r.avg_pnl);
  return stddev(values) || 1;
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
