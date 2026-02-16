/**
 * Confidence calibrator.
 *
 * Continuously calibrates reported confidence against actual outcomes:
 * - Calibration curve: predicted probability vs actual win rate
 * - Overconfidence/underconfidence detection by bucket
 * - Dynamic confidence adjustment factors
 * - Category-specific calibration (crypto vs politics vs sports)
 * - Regime-specific calibration (TREND vs CHOP)
 * - Brier score decomposition (reliability + resolution + uncertainty)
 *
 * Complements bayesian-posterior.js with calibration-specific analytics.
 */

import { getDb } from "../subscribers/db.js";

// Calibration buckets
const BUCKETS = [
  { min: 0.0, max: 0.3, label: "low" },
  { min: 0.3, max: 0.5, label: "below_avg" },
  { min: 0.5, max: 0.6, label: "moderate" },
  { min: 0.6, max: 0.7, label: "above_avg" },
  { min: 0.7, max: 0.8, label: "high" },
  { min: 0.8, max: 1.0, label: "very_high" }
];

/**
 * Compute calibration curve from historical trades.
 *
 * @param {number} days
 * @returns {{ buckets, brierScore, overconfident, underconfident, adjustmentFactors }}
 */
export function computeCalibrationCurve(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT confidence, status, realized_pnl, category, regime
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND confidence IS NOT NULL
    AND realized_pnl IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 20) {
    return { buckets: [], message: "insufficient_data" };
  }

  // Fill buckets
  const bucketData = BUCKETS.map(b => ({
    ...b,
    trades: [],
    wins: 0,
    losses: 0,
    confSum: 0
  }));

  for (const r of rows) {
    const conf = r.confidence;
    for (const bucket of bucketData) {
      if (conf >= bucket.min && conf < bucket.max) {
        bucket.trades.push(r);
        bucket.confSum += conf;
        if (r.status === "WIN") bucket.wins++;
        else bucket.losses++;
        break;
      }
    }
  }

  const buckets = bucketData
    .filter(b => b.trades.length >= 3)
    .map(b => {
      const total = b.wins + b.losses;
      const avgConf = b.confSum / total;
      const actualWR = b.wins / total;
      const gap = actualWR - avgConf;

      return {
        label: b.label,
        range: `${b.min}-${b.max}`,
        trades: total,
        avgConfidence: round3(avgConf),
        actualWinRate: round3(actualWR),
        gap: round3(gap),
        calibration: Math.abs(gap) < 0.05 ? "well_calibrated"
          : gap > 0 ? "underconfident" : "overconfident",
        adjustmentFactor: round3(actualWR / (avgConf || 0.5))
      };
    });

  // Brier score
  let brierSum = 0;
  for (const r of rows) {
    const outcome = r.status === "WIN" ? 1 : 0;
    brierSum += (r.confidence - outcome) ** 2;
  }
  const brierScore = round4(brierSum / rows.length);

  // Decompose Brier score
  const overallWR = rows.filter(r => r.status === "WIN").length / rows.length;
  const uncertainty = round4(overallWR * (1 - overallWR));

  let reliability = 0;
  let resolution = 0;
  for (const b of buckets) {
    const n = b.trades;
    const fk = b.avgConfidence;
    const ok = b.actualWinRate;
    reliability += (n / rows.length) * (fk - ok) ** 2;
    resolution += (n / rows.length) * (ok - overallWR) ** 2;
  }

  // Adjustment factors
  const adjustmentFactors = {};
  for (const b of buckets) {
    adjustmentFactors[b.label] = b.adjustmentFactor;
  }

  const overconfidentBuckets = buckets.filter(b => b.calibration === "overconfident");
  const underconfidentBuckets = buckets.filter(b => b.calibration === "underconfident");

  return {
    buckets,
    brierScore,
    brierDecomposition: {
      reliability: round4(reliability),
      resolution: round4(resolution),
      uncertainty
    },
    overconfidentCount: overconfidentBuckets.length,
    underconfidentCount: underconfidentBuckets.length,
    overallCalibration: overconfidentBuckets.length > underconfidentBuckets.length
      ? "overconfident" : underconfidentBuckets.length > overconfidentBuckets.length
        ? "underconfident" : "balanced",
    adjustmentFactors,
    totalTrades: rows.length,
    lookbackDays: days
  };
}

/**
 * Get category-specific calibration.
 *
 * @param {number} days
 * @returns {{ categories, bestCalibrated, worstCalibrated }}
 */
export function getCategoryCalibration(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT category,
           AVG(confidence) as avg_conf,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
           COUNT(*) as trades
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND confidence IS NOT NULL
    GROUP BY category
    HAVING COUNT(*) >= 5
  `).all(daysOffset);

  const categories = rows.map(r => {
    const actualWR = r.wins / r.trades;
    const avgConf = r.avg_conf || 0.5;
    const gap = actualWR - avgConf;
    const brierProxy = (avgConf - actualWR) ** 2;

    return {
      category: r.category || "unknown",
      trades: r.trades,
      avgConfidence: round3(avgConf),
      actualWinRate: round3(actualWR),
      gap: round3(gap),
      brierProxy: round4(brierProxy),
      calibration: Math.abs(gap) < 0.05 ? "well_calibrated"
        : gap > 0 ? "underconfident" : "overconfident",
      adjustmentFactor: round3(actualWR / (avgConf || 0.5))
    };
  });

  categories.sort((a, b) => a.brierProxy - b.brierProxy);

  return {
    categories,
    bestCalibrated: categories[0] || null,
    worstCalibrated: categories[categories.length - 1] || null,
    avgCalibrationGap: round3(
      categories.reduce((s, c) => s + Math.abs(c.gap), 0) / (categories.length || 1)
    ),
    lookbackDays: days
  };
}

/**
 * Get regime-specific calibration.
 *
 * @param {number} days
 * @returns {{ regimes, bestCalibrated, worstCalibrated }}
 */
export function getRegimeCalibration(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT regime,
           AVG(confidence) as avg_conf,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
           COUNT(*) as trades
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND confidence IS NOT NULL
    GROUP BY regime
    HAVING COUNT(*) >= 5
  `).all(daysOffset);

  const regimes = rows.map(r => {
    const actualWR = r.wins / r.trades;
    const avgConf = r.avg_conf || 0.5;
    const gap = actualWR - avgConf;

    return {
      regime: r.regime || "unknown",
      trades: r.trades,
      avgConfidence: round3(avgConf),
      actualWinRate: round3(actualWR),
      gap: round3(gap),
      calibration: Math.abs(gap) < 0.05 ? "well_calibrated"
        : gap > 0 ? "underconfident" : "overconfident",
      adjustmentFactor: round3(actualWR / (avgConf || 0.5))
    };
  });

  regimes.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));

  return {
    regimes,
    bestCalibrated: regimes[0] || null,
    worstCalibrated: regimes[regimes.length - 1] || null,
    lookbackDays: days
  };
}

/**
 * Adjust a raw confidence value using calibration data.
 *
 * @param {number} rawConfidence
 * @param {string} category
 * @param {string} regime
 * @param {number} days
 * @returns {{ raw, adjusted, adjustmentApplied, source }}
 */
export function adjustConfidence(rawConfidence, category = null, regime = null, days = 30) {
  const curve = computeCalibrationCurve(days);
  if (!curve.buckets || curve.buckets.length === 0) {
    return { raw: rawConfidence, adjusted: rawConfidence, adjustmentApplied: false, source: "no_data" };
  }

  // Find matching bucket
  let factor = 1.0;
  let source = "global";
  for (const b of curve.buckets) {
    const [min, max] = b.range.split("-").map(Number);
    if (rawConfidence >= min && rawConfidence < max) {
      factor = b.adjustmentFactor;
      break;
    }
  }

  // Category-specific override if available
  if (category) {
    const catCal = getCategoryCalibration(days);
    const catMatch = (catCal.categories || []).find(c => c.category === category);
    if (catMatch && catMatch.trades >= 10) {
      factor = catMatch.adjustmentFactor;
      source = `category:${category}`;
    }
  }

  // Regime-specific override if available
  if (regime) {
    const regCal = getRegimeCalibration(days);
    const regMatch = (regCal.regimes || []).find(r => r.regime === regime);
    if (regMatch && regMatch.trades >= 10) {
      factor = (factor + regMatch.adjustmentFactor) / 2; // Blend
      source = regime ? `blend:${source}+regime:${regime}` : source;
    }
  }

  const adjusted = Math.max(0, Math.min(1, round3(rawConfidence * factor)));

  return {
    raw: round3(rawConfidence),
    adjusted,
    adjustmentFactor: round3(factor),
    adjustmentApplied: Math.abs(factor - 1.0) > 0.01,
    source
  };
}

/**
 * Get calibrator dashboard.
 *
 * @returns {{ brierScore, overallCalibration, categoryCount, regimeCount, sampleAdjustment }}
 */
export function getCalibratorDashboard() {
  const curve = computeCalibrationCurve();
  const catCal = getCategoryCalibration();
  const regCal = getRegimeCalibration();
  const sample = adjustConfidence(0.65, null, null, 30);

  return {
    brierScore: curve.brierScore || 0,
    overallCalibration: curve.overallCalibration || "unknown",
    overconfidentBuckets: curve.overconfidentCount || 0,
    underconfidentBuckets: curve.underconfidentCount || 0,
    bestCategory: catCal.bestCalibrated?.category || "unknown",
    worstCategory: catCal.worstCalibrated?.category || "unknown",
    avgCalibrationGap: catCal.avgCalibrationGap || 0,
    bestRegime: regCal.bestCalibrated?.regime || "unknown",
    worstRegime: regCal.worstCalibrated?.regime || "unknown",
    sampleAdjustment: `${sample.raw} → ${sample.adjusted}`,
    totalTrades: curve.totalTrades || 0
  };
}

function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
function round4(v) { return Math.round((v ?? 0) * 10000) / 10000; }
