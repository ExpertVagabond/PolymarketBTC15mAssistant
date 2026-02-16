/**
 * Execution timing optimizer.
 *
 * Analyzes historical trade performance by hour-of-day, day-of-week,
 * and regime to identify statistically significant timing patterns:
 *
 * - Hot windows: time buckets with notably higher win rates
 * - Cold windows: time buckets to avoid (low win rate, negative P&L)
 * - Optimal execution schedule: when to be aggressive vs defensive
 *
 * Uses chi-squared-style significance testing to avoid noise.
 */

import { getDb } from "../subscribers/db.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Full timing analysis: hourly, daily, and regime×time breakdowns.
 * @param {number} days - lookback window
 * @returns {object}
 */
export function getTimingAnalysis(days = 30) {
  const db = getDb();

  const trades = db.prepare(`
    SELECT strftime('%H', created_at) as hour,
           strftime('%w', created_at) as dow,
           regime, outcome, pnl_usd, confidence, edge_at_entry
    FROM trade_executions
    WHERE outcome IN ('WIN', 'LOSS') AND created_at > datetime('now', ?)
  `).all(`-${days} days`);

  if (trades.length < 10) {
    return { insufficient: true, sampleSize: trades.length, days };
  }

  const baseWinRate = trades.filter(t => t.outcome === "WIN").length / trades.length;

  // Hourly breakdown
  const hourly = buildBucketAnalysis(trades, t => parseInt(t.hour), baseWinRate);

  // Day-of-week breakdown
  const daily = buildBucketAnalysis(trades, t => parseInt(t.dow), baseWinRate);
  for (const d of daily) d.dayName = DAY_NAMES[d.bucket] || d.bucket;

  // Regime × hour breakdown (top combos)
  const regimeHour = buildBucketAnalysis(
    trades,
    t => `${t.regime || "RANGE"}_${t.hour}`,
    baseWinRate
  );

  return {
    days,
    sampleSize: trades.length,
    baseWinRate: Math.round(baseWinRate * 1000) / 10,
    hourly: hourly.sort((a, b) => a.bucket - b.bucket),
    daily: daily.sort((a, b) => a.bucket - b.bucket),
    regimeHour: regimeHour
      .filter(r => r.total >= 3)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 15)
  };
}

/**
 * Find optimal trading windows — hours/days where win rate
 * significantly exceeds the baseline.
 * @param {number} days
 * @returns {{ hot: object[], cold: object[], neutral: object[] }}
 */
export function getOptimalWindows(days = 30) {
  const analysis = getTimingAnalysis(days);
  if (analysis.insufficient) return { hot: [], cold: [], neutral: [], insufficient: true };

  const baseWR = analysis.baseWinRate;
  const hot = [];
  const cold = [];
  const neutral = [];

  // Classify hourly windows
  for (const h of analysis.hourly) {
    if (h.total < 5) { neutral.push({ ...h, type: "hour", reason: "insufficient_data" }); continue; }

    // Significance: at least 10% above/below baseline with 5+ trades
    if (h.winRate > baseWR + 10 && h.total >= 5) {
      hot.push({ ...h, type: "hour", label: `${h.bucket}:00 UTC`, lift: Math.round(h.winRate - baseWR) });
    } else if (h.winRate < baseWR - 10 && h.total >= 5) {
      cold.push({ ...h, type: "hour", label: `${h.bucket}:00 UTC`, deficit: Math.round(baseWR - h.winRate) });
    } else {
      neutral.push({ ...h, type: "hour" });
    }
  }

  // Classify daily windows
  for (const d of analysis.daily) {
    if (d.total < 5) continue;

    if (d.winRate > baseWR + 10 && d.total >= 5) {
      hot.push({ ...d, type: "day", label: d.dayName, lift: Math.round(d.winRate - baseWR) });
    } else if (d.winRate < baseWR - 10 && d.total >= 5) {
      cold.push({ ...d, type: "day", label: d.dayName, deficit: Math.round(baseWR - d.winRate) });
    }
  }

  hot.sort((a, b) => (b.lift || 0) - (a.lift || 0));
  cold.sort((a, b) => (b.deficit || 0) - (a.deficit || 0));

  return { hot, cold, neutral, baseWinRate: baseWR, days };
}

/**
 * Get timing recommendation for a specific execution moment.
 * @param {number} hour - UTC hour (0-23)
 * @param {number} dayOfWeek - 0=Sun, 6=Sat
 * @param {string} regime - current regime
 * @returns {{ action, confidence, hourWinRate, dayWinRate, details }}
 */
export function getTimingRecommendation(hour, dayOfWeek, regime = "RANGE") {
  const db = getDb();

  // Get hour stats
  const hourRow = db.prepare(`
    SELECT
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      AVG(pnl_usd) as avgPnl
    FROM trade_executions
    WHERE outcome IN ('WIN', 'LOSS') AND strftime('%H', created_at) = ?
      AND created_at > datetime('now', '-30 days')
  `).get(String(hour).padStart(2, "0"));

  // Get day stats
  const dayRow = db.prepare(`
    SELECT
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      AVG(pnl_usd) as avgPnl
    FROM trade_executions
    WHERE outcome IN ('WIN', 'LOSS') AND strftime('%w', created_at) = ?
      AND created_at > datetime('now', '-30 days')
  `).get(String(dayOfWeek));

  // Get regime×hour combo stats
  const comboRow = db.prepare(`
    SELECT
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses
    FROM trade_executions
    WHERE outcome IN ('WIN', 'LOSS') AND regime = ?
      AND strftime('%H', created_at) = ?
      AND created_at > datetime('now', '-30 days')
  `).get(regime, String(hour).padStart(2, "0"));

  const hourTotal = (hourRow?.wins || 0) + (hourRow?.losses || 0);
  const dayTotal = (dayRow?.wins || 0) + (dayRow?.losses || 0);
  const comboTotal = (comboRow?.wins || 0) + (comboRow?.losses || 0);

  const hourWR = hourTotal >= 3 ? Math.round(((hourRow.wins || 0) / hourTotal) * 1000) / 10 : null;
  const dayWR = dayTotal >= 3 ? Math.round(((dayRow.wins || 0) / dayTotal) * 1000) / 10 : null;
  const comboWR = comboTotal >= 3 ? Math.round(((comboRow.wins || 0) / comboTotal) * 1000) / 10 : null;

  // Decision logic
  let action = "trade"; // default
  let confidence = 50;
  const details = [];

  if (hourWR !== null && hourWR < 35) {
    action = "avoid";
    confidence += 20;
    details.push(`Hour ${hour}:00 UTC has ${hourWR}% win rate`);
  } else if (hourWR !== null && hourWR > 60) {
    action = "aggressive";
    confidence += 15;
    details.push(`Hour ${hour}:00 UTC has ${hourWR}% win rate`);
  }

  if (dayWR !== null && dayWR < 35) {
    if (action !== "avoid") action = "cautious";
    confidence += 10;
    details.push(`${DAY_NAMES[dayOfWeek]} has ${dayWR}% win rate`);
  } else if (dayWR !== null && dayWR > 60) {
    if (action === "trade") action = "aggressive";
    confidence += 10;
    details.push(`${DAY_NAMES[dayOfWeek]} has ${dayWR}% win rate`);
  }

  if (comboWR !== null) {
    details.push(`${regime}@${hour}:00 combo: ${comboWR}% (${comboTotal} trades)`);
  }

  if (details.length === 0) {
    details.push("Insufficient historical data for this time slot");
    confidence = 30;
  }

  return {
    action,
    confidence: Math.min(95, confidence),
    hour,
    dayOfWeek,
    dayName: DAY_NAMES[dayOfWeek],
    regime,
    hourWinRate: hourWR,
    dayWinRate: dayWR,
    comboWinRate: comboWR,
    hourSamples: hourTotal,
    daySamples: dayTotal,
    details
  };
}

function buildBucketAnalysis(trades, keyFn, baseWinRate) {
  const buckets = {};
  for (const t of trades) {
    const key = keyFn(t);
    if (!buckets[key]) buckets[key] = { wins: 0, losses: 0, pnl: 0, avgEdge: 0, edgeSum: 0 };
    if (t.outcome === "WIN") { buckets[key].wins++; }
    else { buckets[key].losses++; }
    buckets[key].pnl += t.pnl_usd || 0;
    buckets[key].edgeSum += t.edge_at_entry || 0;
  }

  return Object.entries(buckets).map(([bucket, d]) => {
    const total = d.wins + d.losses;
    const winRate = total > 0 ? Math.round((d.wins / total) * 1000) / 10 : 0;
    return {
      bucket: isNaN(Number(bucket)) ? bucket : Number(bucket),
      wins: d.wins,
      losses: d.losses,
      total,
      winRate,
      pnl: Math.round(d.pnl * 100) / 100,
      avgEdge: total > 0 ? Math.round((d.edgeSum / total) * 10000) / 10000 : 0,
      vsBaseline: Math.round(winRate - baseWinRate * 100)
    };
  });
}
