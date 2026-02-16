/**
 * Online learning engine.
 *
 * Adaptive weight updates from trade outcomes without full batch retraining:
 * - Online SGD: update feature weights after each trade result
 * - Adaptive learning rate: warmup → steady → decay schedule
 * - Feature importance tracking: which features matter most recently
 * - Performance comparison: online vs batch learning effectiveness
 * - Regime-conditional learning: separate weight vectors per regime
 *
 * Complements the batch weights.js (10-min refresh) with real-time
 * adjustments that react to market changes within seconds.
 */

import { getDb } from "../subscribers/db.js";

// Online weight state
const state = {
  weights: {},          // feature → weight
  regimeWeights: {},    // regime → feature → weight
  learningRate: 0.01,   // Current learning rate
  iteration: 0,
  totalUpdates: 0,
  recentResults: [],    // Last 100 outcomes for tracking
  featureImportance: {},// feature → cumulative gradient magnitude
  performance: {
    onlineCorrect: 0,
    onlineTotal: 0,
    batchCorrect: 0,
    batchTotal: 0
  }
};

// Learning rate schedule
const LR_CONFIG = {
  initial: 0.05,
  warmupSteps: 20,      // Higher LR during warmup
  steadyRate: 0.01,     // Normal learning rate
  decayRate: 0.001,     // Minimum learning rate
  decayAfter: 500       // Start decay after N updates
};

// Features to track
const FEATURES = [
  "confidence", "edge", "quality_score", "regime_strength",
  "volume_signal", "spread_signal", "momentum", "orderbook_imbalance"
];

/**
 * Update weights from a single trade outcome.
 * Called when a trade resolves (WIN/LOSS).
 *
 * @param {object} trade
 * @param {string} trade.status - WIN or LOSS
 * @param {number} trade.confidence
 * @param {number} trade.edge_at_entry
 * @param {number} trade.quality_score
 * @param {string} trade.regime
 * @param {string} trade.category
 * @param {object} trade.features - Additional feature values
 * @returns {{ updated: boolean, prediction: number, actual: number }}
 */
export function updateFromOutcome(trade) {
  if (!trade || !trade.status) return { updated: false };

  state.iteration++;
  state.totalUpdates++;

  // Compute learning rate from schedule
  state.learningRate = computeLearningRate(state.iteration);

  // Extract feature vector
  const features = extractFeatures(trade);
  const regime = trade.regime || "RANGE";

  // Current prediction: sigmoid(w · x)
  const dotProduct = Object.entries(features).reduce((s, [f, v]) => {
    return s + (state.weights[f] ?? 0) * v;
  }, 0);
  const prediction = sigmoid(dotProduct);

  // Actual outcome (1 = WIN, 0 = LOSS)
  const actual = trade.status === "WIN" ? 1 : 0;

  // Error
  const error = actual - prediction;

  // SGD update: w_i += lr * error * x_i
  for (const [feature, value] of Object.entries(features)) {
    const gradient = error * value;

    // Global weights
    state.weights[feature] = (state.weights[feature] ?? 0) + state.learningRate * gradient;

    // Regime-specific weights
    if (!state.regimeWeights[regime]) state.regimeWeights[regime] = {};
    state.regimeWeights[regime][feature] = (state.regimeWeights[regime][feature] ?? 0) + state.learningRate * gradient * 0.5;

    // Track feature importance (cumulative absolute gradient)
    state.featureImportance[feature] = (state.featureImportance[feature] ?? 0) + Math.abs(gradient);
  }

  // Track performance
  const correct = (prediction >= 0.5 && actual === 1) || (prediction < 0.5 && actual === 0);
  state.performance.onlineCorrect += correct ? 1 : 0;
  state.performance.onlineTotal++;

  // Recent results ring buffer
  state.recentResults.push({
    prediction: Math.round(prediction * 1000) / 1000,
    actual,
    correct,
    regime,
    category: trade.category,
    timestamp: Date.now()
  });
  if (state.recentResults.length > 100) {
    state.recentResults = state.recentResults.slice(-100);
  }

  return {
    updated: true,
    prediction: Math.round(prediction * 1000) / 1000,
    actual,
    correct,
    error: Math.round(error * 1000) / 1000,
    learningRate: Math.round(state.learningRate * 10000) / 10000
  };
}

/**
 * Get online prediction for a new signal.
 *
 * @param {object} signal - Signal features
 * @returns {{ probability: number, confidence: string, regimeAdjusted: number }}
 */
export function onlinePredict(signal) {
  const features = extractFeatures(signal);
  const regime = signal.regime || "RANGE";

  // Global prediction
  const globalDot = Object.entries(features).reduce((s, [f, v]) => {
    return s + (state.weights[f] ?? 0) * v;
  }, 0);
  const globalProb = sigmoid(globalDot);

  // Regime-adjusted prediction
  const regimeWts = state.regimeWeights[regime] || {};
  const regimeDot = Object.entries(features).reduce((s, [f, v]) => {
    return s + (regimeWts[f] ?? 0) * v;
  }, 0);
  const regimeProb = sigmoid(globalDot + regimeDot);

  // Blend: 70% global + 30% regime
  const blended = globalProb * 0.7 + regimeProb * 0.3;

  return {
    probability: Math.round(blended * 1000) / 1000,
    globalProbability: Math.round(globalProb * 1000) / 1000,
    regimeAdjusted: Math.round(regimeProb * 1000) / 1000,
    confidence: blended > 0.65 ? "high" : blended > 0.55 ? "medium" : "low"
  };
}

/**
 * Get current learner status and diagnostics.
 *
 * @returns {{ weights, performance, featureImportance, learningRate, recentAccuracy }}
 */
export function getOnlineLearnerStatus() {
  // Recent accuracy (last 50 trades)
  const recent = state.recentResults.slice(-50);
  const recentCorrect = recent.filter(r => r.correct).length;
  const recentAccuracy = recent.length > 0 ? Math.round(recentCorrect / recent.length * 1000) / 1000 : 0;

  // By regime accuracy
  const byRegime = {};
  for (const r of recent) {
    const key = r.regime || "unknown";
    if (!byRegime[key]) byRegime[key] = { correct: 0, total: 0 };
    byRegime[key].total++;
    if (r.correct) byRegime[key].correct++;
  }
  for (const key of Object.keys(byRegime)) {
    byRegime[key].accuracy = Math.round(byRegime[key].correct / byRegime[key].total * 1000) / 1000;
  }

  // Feature importance ranking
  const totalImportance = Object.values(state.featureImportance).reduce((s, v) => s + v, 0) || 1;
  const featureRanking = Object.entries(state.featureImportance)
    .map(([f, imp]) => ({
      feature: f,
      importance: Math.round(imp * 1000) / 1000,
      share: Math.round(imp / totalImportance * 1000) / 1000
    }))
    .sort((a, b) => b.importance - a.importance);

  // Weight magnitudes
  const weightSummary = Object.entries(state.weights)
    .map(([f, w]) => ({ feature: f, weight: Math.round(w * 10000) / 10000 }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  return {
    iteration: state.iteration,
    totalUpdates: state.totalUpdates,
    learningRate: Math.round(state.learningRate * 10000) / 10000,
    lrPhase: state.iteration < LR_CONFIG.warmupSteps ? "warmup"
      : state.iteration < LR_CONFIG.decayAfter ? "steady" : "decay",
    recentAccuracy,
    recentSampleSize: recent.length,
    overallAccuracy: state.performance.onlineTotal > 0
      ? Math.round(state.performance.onlineCorrect / state.performance.onlineTotal * 1000) / 1000 : 0,
    byRegime,
    featureRanking,
    weights: weightSummary,
    regimeWeightCount: Object.keys(state.regimeWeights).length
  };
}

/**
 * Bootstrap weights from historical trade data.
 * Runs a single pass over recent trades to initialize weights.
 *
 * @param {number} days - Lookback period
 * @returns {{ tradesProcessed: number, accuracy: number }}
 */
export function bootstrapFromHistory(days = 7) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 30)} days`;

  const rows = db.prepare(`
    SELECT confidence, edge_at_entry, quality_score, regime, category, status
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    ORDER BY created_at ASC
  `).all(daysOffset);

  let processed = 0;
  let correct = 0;

  for (const row of rows) {
    const result = updateFromOutcome({
      status: row.status,
      confidence: row.confidence,
      edge_at_entry: row.edge_at_entry,
      quality_score: row.quality_score,
      regime: row.regime,
      category: row.category
    });

    if (result.updated) {
      processed++;
      if (result.correct) correct++;
    }
  }

  return {
    tradesProcessed: processed,
    accuracy: processed > 0 ? Math.round(correct / processed * 1000) / 1000 : 0,
    finalLearningRate: Math.round(state.learningRate * 10000) / 10000,
    weightsCount: Object.keys(state.weights).length
  };
}

// Helper functions

function extractFeatures(trade) {
  return {
    confidence: trade.confidence ?? 0.5,
    edge: trade.edge_at_entry ?? trade.edge ?? 0,
    quality_score: trade.quality_score ?? 50,
    regime_strength: getRegimeStrength(trade.regime),
    volume_signal: normalizeVolume(trade.features?.volume24h),
    spread_signal: normalizeSpread(trade.features?.spread),
    momentum: trade.features?.momentum ?? 0,
    orderbook_imbalance: trade.features?.imbalance ?? 0
  };
}

function getRegimeStrength(regime) {
  const map = { TREND_UP: 0.8, TREND_DOWN: 0.8, RANGE: 0.5, CHOP: 0.2 };
  return map[regime] ?? 0.5;
}

function normalizeVolume(vol) {
  if (!vol) return 0.5;
  return Math.min(1, vol / 50000);
}

function normalizeSpread(spread) {
  if (!spread) return 0.5;
  return Math.max(0, 1 - spread * 10); // Tight spread = high signal
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, x))));
}

function computeLearningRate(iteration) {
  if (iteration < LR_CONFIG.warmupSteps) {
    // Linear warmup
    return LR_CONFIG.initial * (iteration / LR_CONFIG.warmupSteps);
  }
  if (iteration < LR_CONFIG.decayAfter) {
    return LR_CONFIG.steadyRate;
  }
  // Inverse sqrt decay
  const decaySteps = iteration - LR_CONFIG.decayAfter;
  return Math.max(LR_CONFIG.decayRate, LR_CONFIG.steadyRate / Math.sqrt(1 + decaySteps / 100));
}
