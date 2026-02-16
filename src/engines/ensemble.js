/**
 * Model ensemble framework.
 *
 * Combines independent scoring models into a weighted ensemble:
 * 1. Momentum model (RSI, MACD, stochastic — trend following)
 * 2. Mean-reversion model (Bollinger, VWAP deviation — contrarian)
 * 3. Orderbook model (depth imbalance, spread, flow)
 * 4. Macro model (BTC correlation, regime alignment)
 *
 * Each model independently estimates P(UP) from 0 to 1.
 * Ensemble output = weighted average with dynamic weight learning.
 * Weights adjust based on recent model accuracy (EMA of hit rate).
 */

import { getDb } from "../subscribers/db.js";
import { clamp } from "../utils.js";

// Default model weights (equal at start)
const DEFAULT_WEIGHTS = {
  momentum:      0.25,
  meanReversion: 0.25,
  orderbook:     0.25,
  macro:         0.25
};

// In-memory learned weights (EMA-updated from outcomes)
let modelWeights = { ...DEFAULT_WEIGHTS };
let modelStats = {
  momentum:      { correct: 0, total: 0, recentAccuracy: 0.5 },
  meanReversion: { correct: 0, total: 0, recentAccuracy: 0.5 },
  orderbook:     { correct: 0, total: 0, recentAccuracy: 0.5 },
  macro:         { correct: 0, total: 0, recentAccuracy: 0.5 }
};

const EMA_ALPHA = 0.1; // smoothing for accuracy tracking

/**
 * Momentum model: trend-following using RSI, MACD, stochastic.
 * Returns P(UP) from 0 to 1.
 */
function momentumModel(tick) {
  let score = 0.5;
  const scored = tick.scored;
  if (!scored || scored.degenerate) return { pUp: 0.5, confidence: 0 };

  // RSI
  const rsi = scored.rsi ?? tick.indicators?.rsi;
  if (rsi != null) {
    if (rsi > 60) score += 0.1;
    else if (rsi > 70) score += 0.15;
    else if (rsi < 40) score -= 0.1;
    else if (rsi < 30) score -= 0.15;
  }

  // MACD histogram
  const macdHist = scored.macdHist ?? tick.indicators?.macdHist;
  if (macdHist != null) {
    score += clamp(macdHist * 5, -0.15, 0.15);
  }

  // Stochastic
  const stochK = scored.stochK ?? scored.stochastic;
  if (stochK != null) {
    if (stochK > 80) score += 0.05;
    else if (stochK < 20) score -= 0.05;
  }

  return { pUp: clamp(score, 0.05, 0.95), confidence: rsi != null ? 0.7 : 0.3 };
}

/**
 * Mean-reversion model: contrarian using Bollinger bands and VWAP deviation.
 * Returns P(UP) from 0 to 1.
 */
function meanReversionModel(tick) {
  let score = 0.5;

  // Bollinger position
  const bbPos = tick.scored?.bbPosition ?? tick.indicators?.bbPosition;
  if (bbPos != null) {
    // Near lower band = mean-reversion UP, near upper = DOWN
    if (bbPos < 0.2) score += 0.15;       // oversold → revert up
    else if (bbPos < 0.35) score += 0.08;
    else if (bbPos > 0.8) score -= 0.15;   // overbought → revert down
    else if (bbPos > 0.65) score -= 0.08;
  }

  // VWAP deviation
  const price = tick.prices?.up ?? tick.price;
  const vwap = tick.indicators?.vwap ?? tick.vwap;
  if (price != null && vwap != null && vwap > 0) {
    const deviation = (price - vwap) / vwap;
    // Large deviation = expect reversion
    if (deviation > 0.02) score -= 0.1;    // price above VWAP → expect drop
    else if (deviation < -0.02) score += 0.1; // below VWAP → expect rise
  }

  const hasData = bbPos != null || (price != null && vwap != null);
  return { pUp: clamp(score, 0.05, 0.95), confidence: hasData ? 0.6 : 0.2 };
}

/**
 * Orderbook model: depth imbalance, spread, microstructure.
 * Returns P(UP) from 0 to 1.
 */
function orderbookModel(tick) {
  let score = 0.5;

  // Orderbook imbalance
  const imbalance = tick.scored?.orderbookImbalance ?? tick.orderFlow?.imbalance;
  if (imbalance != null) {
    // imbalance > 1 = more bids = bullish, < 1 = more asks = bearish
    if (imbalance > 1.5) score += 0.15;
    else if (imbalance > 1.2) score += 0.08;
    else if (imbalance < 0.67) score -= 0.15;
    else if (imbalance < 0.83) score -= 0.08;
  }

  // Micro health
  const microHealth = tick.orderFlow?.microHealth;
  if (microHealth != null) {
    // High micro health supports the current trend direction
    if (microHealth > 70) score += 0.05;
    else if (microHealth < 30) score -= 0.05;
  }

  return { pUp: clamp(score, 0.05, 0.95), confidence: imbalance != null ? 0.65 : 0.15 };
}

/**
 * Macro model: BTC correlation, regime alignment, market-level sentiment.
 * Returns P(UP) from 0 to 1.
 */
function macroModel(tick) {
  let score = 0.5;

  // Regime
  const regime = tick.regimeInfo?.regime || tick.regime;
  if (regime === "TREND_UP") score += 0.12;
  else if (regime === "TREND_DOWN") score -= 0.12;
  else if (regime === "CHOP") score *= 0.9; // dampen in chop

  // BTC correlation adjustment
  const btcCorr = tick.btcCorr ?? tick.correlation;
  if (btcCorr != null) {
    score += clamp(btcCorr * 0.08, -0.1, 0.1);
  }

  // Regime stability
  const stability = tick.regimeInfo?.stability;
  if (stability != null && stability > 70) {
    // High stability amplifies the regime signal
    const amp = 1 + (stability - 70) / 300;
    score = 0.5 + (score - 0.5) * amp;
  }

  return { pUp: clamp(score, 0.05, 0.95), confidence: regime ? 0.6 : 0.2 };
}

const MODELS = {
  momentum:      momentumModel,
  meanReversion: meanReversionModel,
  orderbook:     orderbookModel,
  macro:         macroModel
};

/**
 * Run the full ensemble on a tick.
 * @param {object} tick - Signal tick with indicator data
 * @returns {{ pUp, pDown, side, ensembleEdge, modelOutputs, weights }}
 */
export function ensemblePredict(tick) {
  const modelOutputs = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [name, fn] of Object.entries(MODELS)) {
    const result = fn(tick);
    const weight = modelWeights[name] || 0.25;
    const effectiveWeight = weight * result.confidence;

    modelOutputs[name] = {
      pUp: result.pUp,
      confidence: result.confidence,
      weight,
      effectiveWeight: Math.round(effectiveWeight * 1000) / 1000
    };

    weightedSum += result.pUp * effectiveWeight;
    totalWeight += effectiveWeight;
  }

  const pUp = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  const pDown = 1 - pUp;
  const side = pUp >= 0.5 ? "UP" : "DOWN";
  const ensembleEdge = Math.abs(pUp - 0.5) * 2; // 0 to 1

  return {
    pUp: Math.round(pUp * 1000) / 1000,
    pDown: Math.round(pDown * 1000) / 1000,
    side,
    ensembleEdge: Math.round(ensembleEdge * 1000) / 1000,
    agreement: getAgreement(modelOutputs),
    modelOutputs,
    weights: { ...modelWeights }
  };
}

function getAgreement(outputs) {
  const sides = Object.values(outputs).map(o => o.pUp >= 0.5 ? "UP" : "DOWN");
  const upCount = sides.filter(s => s === "UP").length;
  const total = sides.length;
  return { upVotes: upCount, downVotes: total - upCount, unanimous: upCount === total || upCount === 0, consensus: Math.max(upCount, total - upCount) / total };
}

/**
 * Update model weights based on an observed outcome.
 * Called when a signal settles.
 * @param {object} modelOutputs - from ensemblePredict
 * @param {string} actualOutcome - "WIN" or "LOSS"
 * @param {string} side - "UP" or "DOWN"
 */
export function updateEnsembleWeights(modelOutputs, actualOutcome, side) {
  for (const [name, output] of Object.entries(modelOutputs)) {
    if (!modelStats[name]) continue;

    const predicted = output.pUp >= 0.5 ? "UP" : "DOWN";
    const correct = (predicted === side && actualOutcome === "WIN") || (predicted !== side && actualOutcome === "LOSS");

    modelStats[name].total++;
    if (correct) modelStats[name].correct++;

    // EMA accuracy
    modelStats[name].recentAccuracy = EMA_ALPHA * (correct ? 1 : 0) + (1 - EMA_ALPHA) * modelStats[name].recentAccuracy;
  }

  // Rebalance weights proportional to recent accuracy
  const totalAccuracy = Object.values(modelStats).reduce((s, m) => s + m.recentAccuracy, 0);
  if (totalAccuracy > 0) {
    for (const name of Object.keys(modelWeights)) {
      modelWeights[name] = Math.round((modelStats[name].recentAccuracy / totalAccuracy) * 1000) / 1000;
    }
  }
}

/**
 * Get current ensemble weights and per-model stats.
 */
export function getEnsembleWeights() {
  return { weights: { ...modelWeights }, defaultWeights: DEFAULT_WEIGHTS };
}

/**
 * Get per-model performance stats.
 */
export function getModelPerformance() {
  const models = {};
  for (const [name, stats] of Object.entries(modelStats)) {
    models[name] = {
      ...stats,
      accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 1000) / 1000 : null,
      weight: modelWeights[name]
    };
  }
  return { models, totalPredictions: Object.values(modelStats).reduce((s, m) => s + m.total, 0) };
}
