/**
 * Signal conflict resolution & priority arbitration.
 *
 * Resolves disagreements between multiple signal sources:
 * - Conflict detection when models disagree on direction/intensity
 * - Priority ranking by risk-adjusted edge
 * - Win-rate weighted signal arbitration
 * - Regime veto mechanism (suppress signals in hostile regimes)
 * - Signal queue management for simultaneous signals
 *
 * Enriches ensemble.js decisions with conflict awareness.
 */

import { getDb } from "../subscribers/db.js";

// Signal source weight defaults (calibrated from historical performance)
const DEFAULT_SOURCE_WEIGHTS = {
  edge: 0.25,
  confluence: 0.20,
  regime: 0.20,
  orderflow: 0.15,
  sentiment: 0.10,
  microstructure: 0.10
};

// Regime veto rules
const REGIME_VETO_RULES = {
  CHOP: { minConfidence: 0.70, maxSignals: 2, vetoLowEdge: true },
  RANGE: { minConfidence: 0.55, maxSignals: 5, vetoLowEdge: false },
  TREND_UP: { minConfidence: 0.50, maxSignals: 8, vetoLowEdge: false },
  TREND_DOWN: { minConfidence: 0.50, maxSignals: 8, vetoLowEdge: false }
};

/**
 * Detect conflicts between multiple signal outputs.
 *
 * @param {object[]} signals - Array of signal objects
 * @param {string} signals[].source - Signal source name
 * @param {number} signals[].direction - -1 to +1
 * @param {number} signals[].confidence - 0 to 1
 * @param {number} signals[].edge - Expected edge
 * @returns {{ conflictScore, conflicts, resolution, consensus }}
 */
export function detectSignalConflict(signals = []) {
  if (signals.length < 2) {
    return { conflictScore: 0, conflicts: [], resolution: "single_signal", consensus: signals[0]?.direction || 0 };
  }

  const directions = signals.map(s => s.direction || 0);
  const avgDirection = directions.reduce((s, d) => s + d, 0) / directions.length;

  // Detect directional disagreements
  const conflicts = [];
  const bullish = signals.filter(s => (s.direction || 0) > 0.1);
  const bearish = signals.filter(s => (s.direction || 0) < -0.1);
  const neutral = signals.filter(s => Math.abs(s.direction || 0) <= 0.1);

  if (bullish.length > 0 && bearish.length > 0) {
    conflicts.push({
      type: "directional",
      bullishSources: bullish.map(s => s.source),
      bearishSources: bearish.map(s => s.source),
      severity: Math.min(bullish.length, bearish.length) > 1 ? "high" : "moderate"
    });
  }

  // Detect intensity disagreements (same direction but very different magnitude)
  const confidences = signals.map(s => s.confidence || 0.5);
  const confRange = Math.max(...confidences) - Math.min(...confidences);
  if (confRange > 0.3) {
    conflicts.push({
      type: "intensity",
      range: round3(confRange),
      highConfSource: signals.reduce((a, b) => (a.confidence || 0) > (b.confidence || 0) ? a : b).source,
      lowConfSource: signals.reduce((a, b) => (a.confidence || 0) < (b.confidence || 0) ? a : b).source,
      severity: confRange > 0.5 ? "high" : "moderate"
    });
  }

  // Conflict score (0-100)
  const dirConflict = bullish.length > 0 && bearish.length > 0
    ? Math.min(bullish.length, bearish.length) / signals.length * 60
    : 0;
  const intConflict = confRange * 40;
  const conflictScore = Math.min(100, Math.round(dirConflict + intConflict));

  // Resolution strategy
  let resolution;
  if (conflictScore < 20) resolution = "consensus";
  else if (conflictScore < 50) resolution = "weight_by_confidence";
  else resolution = "defer_to_highest_edge";

  return {
    conflictScore,
    conflicts,
    resolution,
    consensus: round3(avgDirection),
    signalCount: signals.length,
    directionalSplit: { bullish: bullish.length, bearish: bearish.length, neutral: neutral.length }
  };
}

/**
 * Rank and arbitrate competing signals by risk-adjusted edge.
 *
 * @param {object[]} signals
 * @param {object} portfolio - Current portfolio state
 * @param {number} portfolio.openPositions
 * @param {number} portfolio.dailyPnl
 * @returns {{ ranked, executeOnly, skip }}
 */
export function arbitrateSignalPriority(signals = [], portfolio = {}) {
  const openPositions = portfolio.openPositions || 0;
  const dailyPnl = portfolio.dailyPnl || 0;

  // Score each signal
  const scored = signals.map(s => {
    const edge = Math.abs(s.edge || 0);
    const confidence = s.confidence || 0.5;
    const sourceWeight = DEFAULT_SOURCE_WEIGHTS[s.source] || 0.10;

    // Risk-adjusted priority score
    const riskAdjustedEdge = edge * confidence * sourceWeight;

    // Penalty for portfolio congestion
    const congestionPenalty = openPositions > 8 ? 0.5 : openPositions > 5 ? 0.8 : 1.0;

    // Penalty for drawdown state
    const drawdownPenalty = dailyPnl < -20 ? 0.4 : dailyPnl < -10 ? 0.7 : 1.0;

    const priority = round3(riskAdjustedEdge * congestionPenalty * drawdownPenalty);

    return {
      ...s,
      riskAdjustedEdge: round3(riskAdjustedEdge),
      priority,
      penalties: {
        congestion: round3(congestionPenalty),
        drawdown: round3(drawdownPenalty)
      }
    };
  });

  scored.sort((a, b) => b.priority - a.priority);

  // Determine which to execute vs skip
  const maxExecute = dailyPnl < -15 ? 1 : dailyPnl < -5 ? 2 : 3;
  const executeOnly = scored.filter(s => s.priority > 0.01).slice(0, maxExecute);
  const skip = scored.filter(s => !executeOnly.includes(s));

  return {
    ranked: scored,
    executeOnly: executeOnly.map(s => ({
      source: s.source,
      direction: s.direction,
      priority: s.priority,
      marketId: s.marketId
    })),
    skip: skip.map(s => ({
      source: s.source,
      reason: s.priority <= 0.01 ? "low_priority" : "capacity_limit",
      priority: s.priority
    })),
    maxAllowed: maxExecute
  };
}

/**
 * Compute win-rate weighted signal ensemble.
 *
 * @param {number} days - Lookback
 * @returns {{ weights, confidence, recentPerformance }}
 */
export function computeWinRateWeights(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT sizing_method as source,
           COUNT(*) as trades,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
           AVG(realized_pnl) as avg_pnl
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY sizing_method
    HAVING COUNT(*) >= 5
  `).all(daysOffset);

  if (rows.length === 0) {
    return { weights: DEFAULT_SOURCE_WEIGHTS, confidence: 0, message: "using_defaults" };
  }

  // Win-rate weighted
  const totalWinRate = rows.reduce((s, r) => s + r.wins / r.trades, 0);
  const weights = {};
  for (const r of rows) {
    const source = r.source || "default";
    const winRate = r.wins / r.trades;
    weights[source] = round3(winRate / (totalWinRate || 1));
  }

  // Confidence in weights (based on sample size)
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  const confidence = Math.min(1, totalTrades / 100);

  const recentPerformance = rows.map(r => ({
    source: r.source || "default",
    trades: r.trades,
    winRate: round3(r.wins / r.trades),
    avgPnl: round2(r.avg_pnl),
    weight: weights[r.source || "default"] || 0
  })).sort((a, b) => b.weight - a.weight);

  return {
    weights,
    confidence: round3(confidence),
    recentPerformance,
    totalTrades,
    lookbackDays: days
  };
}

/**
 * Apply regime veto to suppress inappropriate signals.
 *
 * @param {object} signal
 * @param {string} regime - Current regime
 * @param {number} openPositionCount
 * @returns {{ vetoed, reason, confidenceDiscount, adjustedConfidence }}
 */
export function applyRegimeVeto(signal = {}, regime = "RANGE", openPositionCount = 0) {
  const rules = REGIME_VETO_RULES[regime] || REGIME_VETO_RULES.RANGE;
  const confidence = signal.confidence || 0.5;
  const edge = Math.abs(signal.edge || 0);

  // Check confidence threshold
  if (confidence < rules.minConfidence) {
    return {
      vetoed: true,
      reason: `${regime} regime requires ≥${rules.minConfidence} confidence (got ${round3(confidence)})`,
      confidenceDiscount: 1.0,
      adjustedConfidence: 0
    };
  }

  // Check position count limit
  if (openPositionCount >= rules.maxSignals) {
    return {
      vetoed: true,
      reason: `${regime} regime caps signals at ${rules.maxSignals} (have ${openPositionCount})`,
      confidenceDiscount: 1.0,
      adjustedConfidence: 0
    };
  }

  // Check low edge veto
  if (rules.vetoLowEdge && edge < 0.03) {
    return {
      vetoed: true,
      reason: `${regime} regime vetoes low-edge trades (edge ${round3(edge)} < 0.03)`,
      confidenceDiscount: 1.0,
      adjustedConfidence: 0
    };
  }

  // Apply confidence discount for hostile regimes
  let discount = 0;
  if (regime === "CHOP") discount = 0.3;
  else if (regime === "RANGE" && confidence < 0.6) discount = 0.1;

  return {
    vetoed: false,
    reason: null,
    confidenceDiscount: round3(discount),
    adjustedConfidence: round3(confidence * (1 - discount))
  };
}

/**
 * Get signal arbitration dashboard.
 *
 * @returns {{ weights, vetoRules, conflictThresholds }}
 */
export function getArbiterStatus() {
  const weights = computeWinRateWeights();

  return {
    sourceWeights: weights.weights,
    weightConfidence: weights.confidence,
    topSources: weights.recentPerformance?.slice(0, 5) || [],
    vetoRules: Object.entries(REGIME_VETO_RULES).map(([regime, rules]) => ({
      regime,
      minConfidence: rules.minConfidence,
      maxSignals: rules.maxSignals,
      vetoLowEdge: rules.vetoLowEdge
    })),
    totalTradesAnalyzed: weights.totalTrades || 0
  };
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
