/**
 * Walk-forward backtester with out-of-sample validation.
 *
 * Rolling window train/test splits for rigorous strategy validation:
 * - Configurable train/test/step windows
 * - Per-window performance metrics (in-sample vs out-of-sample)
 * - Overfit ratio: in-sample vs out-of-sample degradation
 * - Parameter drift detection across windows
 * - Aggregate stability metrics
 *
 * Gold-standard validation: proves strategy generalizes
 * beyond the data it was trained on.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Plan walk-forward windows.
 *
 * @param {object} config
 * @param {number} config.totalDays - Total lookback
 * @param {number} config.trainDays - Training window size
 * @param {number} config.testDays - Test window size
 * @param {number} config.stepDays - Advance per iteration
 * @returns {{ windows, windowCount, coverage }}
 */
export function planWalkForward(config = {}) {
  const totalDays = Math.min(config.totalDays || 60, 180);
  const trainDays = config.trainDays || 20;
  const testDays = config.testDays || 5;
  const stepDays = config.stepDays || 5;

  const windows = [];
  let offset = 0;

  while (offset + trainDays + testDays <= totalDays) {
    windows.push({
      windowId: windows.length,
      trainStart: totalDays - offset - trainDays - testDays,
      trainEnd: totalDays - offset - testDays,
      testStart: totalDays - offset - testDays,
      testEnd: totalDays - offset,
      trainDays,
      testDays
    });
    offset += stepDays;
  }

  return {
    windows: windows.reverse(), // chronological order
    windowCount: windows.length,
    totalDays,
    trainDays,
    testDays,
    stepDays,
    coverage: round3((windows.length * testDays) / totalDays)
  };
}

/**
 * Run walk-forward validation on historical trades.
 *
 * @param {object} config - Same as planWalkForward
 * @returns {{ windows, aggregate, overfitAnalysis, parameterDrift }}
 */
export function runWalkForward(config = {}) {
  const db = getDb();
  const plan = planWalkForward(config);

  if (plan.windowCount === 0) {
    return { windows: [], aggregate: null, message: "no_windows" };
  }

  const totalDays = plan.totalDays;
  const totalOffset = `-${totalDays} days`;

  // Get all trades in the lookback period
  const rows = db.prepare(`
    SELECT realized_pnl, confidence, edge_at_entry, quality_score,
           status, regime, category, created_at,
           julianday('now') - julianday(created_at) as days_ago
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    ORDER BY created_at ASC
  `).all(totalOffset);

  if (rows.length < 20) {
    return { windows: [], aggregate: null, message: "insufficient_data" };
  }

  // Process each window
  const windowResults = [];

  for (const w of plan.windows) {
    const trainTrades = rows.filter(r => r.days_ago >= w.trainStart && r.days_ago < w.trainEnd);
    const testTrades = rows.filter(r => r.days_ago >= w.testStart && r.days_ago < w.testEnd);

    if (trainTrades.length < 5 || testTrades.length < 2) continue;

    // Train metrics
    const trainMetrics = computeWindowMetrics(trainTrades);

    // Find optimal confidence threshold on training set
    const optimalConf = findOptimalThreshold(trainTrades);

    // Test metrics (applying trained threshold)
    const filteredTest = testTrades.filter(t => (t.confidence || 0) >= optimalConf);
    const testMetrics = filteredTest.length >= 2
      ? computeWindowMetrics(filteredTest)
      : computeWindowMetrics(testTrades);

    // Overfit ratio: how much did performance degrade out-of-sample?
    const overfitRatio = trainMetrics.sharpe > 0
      ? round3(testMetrics.sharpe / trainMetrics.sharpe)
      : 0;

    windowResults.push({
      windowId: w.windowId,
      trainTrades: trainTrades.length,
      testTrades: testTrades.length,
      filteredTestTrades: filteredTest.length,
      optimalConfidence: round3(optimalConf),
      trainMetrics,
      testMetrics,
      overfitRatio,
      degradation: round3(1 - overfitRatio)
    });
  }

  if (windowResults.length === 0) {
    return { windows: [], aggregate: null, message: "no_valid_windows" };
  }

  // Aggregate across all windows
  const aggregate = computeAggregateMetrics(windowResults);

  // Parameter drift analysis
  const parameterDrift = analyzeParameterDrift(windowResults);

  return {
    windows: windowResults,
    aggregate,
    overfitAnalysis: {
      avgOverfitRatio: aggregate.avgOverfitRatio,
      isOverfit: aggregate.avgOverfitRatio < 0.5,
      isRobust: aggregate.avgOverfitRatio > 0.7,
      verdict: aggregate.avgOverfitRatio > 0.7 ? "robust"
        : aggregate.avgOverfitRatio > 0.5 ? "moderate"
        : "likely_overfit"
    },
    parameterDrift,
    plan: { windows: plan.windowCount, totalDays: plan.totalDays }
  };
}

/**
 * Get walk-forward summary with stability score.
 *
 * @param {number} days
 * @returns {{ stabilityScore, windows, overfit, recommendation }}
 */
export function getWalkForwardSummary(days = 60) {
  const result = runWalkForward({ totalDays: days });

  if (!result.aggregate) {
    return { stabilityScore: 0, message: result.message || "no_data" };
  }

  // Stability score (0-100)
  let score = 50;

  // Overfit ratio contribution (0-30 points)
  score += Math.min(30, result.aggregate.avgOverfitRatio * 30);

  // Consistency contribution (0-20 points)
  const profitableWindows = result.windows.filter(w => w.testMetrics.totalPnl > 0).length;
  score += (profitableWindows / result.windows.length) * 20;

  // Sharpe contribution (0-20 points)
  score += Math.min(20, Math.max(0, result.aggregate.avgTestSharpe * 10));

  // Parameter stability (0-10 points)
  if (result.parameterDrift && !result.parameterDrift.isDrifting) score += 10;

  // Penalty for high degradation
  if (result.aggregate.avgDegradation > 0.5) score -= 20;

  const stabilityScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    stabilityScore,
    verdict: stabilityScore > 70 ? "stable" : stabilityScore > 45 ? "moderate" : "unstable",
    windowCount: result.windows.length,
    profitableWindows,
    avgOverfitRatio: result.aggregate.avgOverfitRatio,
    avgTrainSharpe: result.aggregate.avgTrainSharpe,
    avgTestSharpe: result.aggregate.avgTestSharpe,
    parameterStable: result.parameterDrift ? !result.parameterDrift.isDrifting : null,
    recommendation: stabilityScore > 70
      ? "Strategy generalizes well — safe to deploy"
      : stabilityScore > 45
        ? "Moderate generalization — monitor closely, consider reducing size"
        : "Poor generalization — likely overfit, avoid live deployment"
  };
}

// Internal helpers

function computeWindowMetrics(trades) {
  if (trades.length === 0) return { winRate: 0, totalPnl: 0, avgPnl: 0, sharpe: 0, maxDrawdown: 0, trades: 0 };

  const pnls = trades.map(t => t.realized_pnl);
  const wins = trades.filter(t => t.status === "WIN").length;
  const totalPnl = pnls.reduce((s, v) => s + v, 0);
  const avgPnl = totalPnl / pnls.length;

  const std = stddev(pnls);
  const sharpe = std > 0 ? avgPnl / std * Math.sqrt(252) : 0;

  // Max drawdown
  let maxPnl = 0, maxDD = 0, cumPnl = 0;
  for (const p of pnls) {
    cumPnl += p;
    if (cumPnl > maxPnl) maxPnl = cumPnl;
    const dd = maxPnl - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    winRate: round3(wins / trades.length),
    totalPnl: round2(totalPnl),
    avgPnl: round2(avgPnl),
    sharpe: round2(sharpe),
    maxDrawdown: round2(maxDD),
    trades: trades.length
  };
}

function findOptimalThreshold(trades) {
  const thresholds = [0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
  let bestSharpe = -Infinity;
  let bestThreshold = 0.50;

  for (const t of thresholds) {
    const filtered = trades.filter(tr => (tr.confidence || 0) >= t);
    if (filtered.length < 3) continue;
    const metrics = computeWindowMetrics(filtered);
    if (metrics.sharpe > bestSharpe) {
      bestSharpe = metrics.sharpe;
      bestThreshold = t;
    }
  }

  return bestThreshold;
}

function computeAggregateMetrics(windowResults) {
  const trainSharpes = windowResults.map(w => w.trainMetrics.sharpe);
  const testSharpes = windowResults.map(w => w.testMetrics.sharpe);
  const overfitRatios = windowResults.map(w => w.overfitRatio);
  const degradations = windowResults.map(w => w.degradation);

  return {
    avgTrainSharpe: round2(avg(trainSharpes)),
    avgTestSharpe: round2(avg(testSharpes)),
    avgOverfitRatio: round3(avg(overfitRatios)),
    avgDegradation: round3(avg(degradations)),
    trainSharpeStd: round2(stddev(trainSharpes)),
    testSharpeStd: round2(stddev(testSharpes)),
    totalTrainTrades: windowResults.reduce((s, w) => s + w.trainTrades, 0),
    totalTestTrades: windowResults.reduce((s, w) => s + w.testTrades, 0)
  };
}

function analyzeParameterDrift(windowResults) {
  const thresholds = windowResults.map(w => w.optimalConfidence);
  if (thresholds.length < 3) return { isDrifting: false, message: "insufficient_windows" };

  const mean = avg(thresholds);
  const std = stddev(thresholds);
  const cv = mean > 0 ? std / mean : 0;

  // Check for monotonic trend
  let increasing = 0, decreasing = 0;
  for (let i = 1; i < thresholds.length; i++) {
    if (thresholds[i] > thresholds[i - 1]) increasing++;
    else if (thresholds[i] < thresholds[i - 1]) decreasing++;
  }
  const n = thresholds.length - 1;
  const hasTrend = increasing / n > 0.7 || decreasing / n > 0.7;

  return {
    isDrifting: cv > 0.15 || hasTrend,
    coefficientOfVariation: round3(cv),
    hasTrend,
    trendDirection: increasing > decreasing ? "increasing" : "decreasing",
    meanThreshold: round3(mean),
    stdThreshold: round3(std),
    thresholdHistory: thresholds.map(round3)
  };
}

function avg(arr) { return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function stddev(arr) {
  if (arr.length === 0) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
