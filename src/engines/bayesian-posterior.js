/**
 * Bayesian posterior probability tracker.
 *
 * Maintains and updates Bayesian beliefs for signal sources:
 * - Beta-Binomial conjugate prior/posterior for win rate estimation
 * - Credible interval tracking (90%, 95%)
 * - Information gain measurement per update
 * - Model belief evolution over time
 * - Prior calibration from historical data
 *
 * Complements confidence.js with adaptive Bayesian refinement.
 */

import { getDb } from "../subscribers/db.js";

// In-memory posterior store
const posteriors = {};  // key → { alpha, beta, updates, history }

// Default prior: mildly informative (55% win rate expectation)
const DEFAULT_PRIOR = { alpha: 5.5, beta: 4.5 };

/**
 * Initialize or get posterior for a signal source.
 *
 * @param {string} key - Source identifier (e.g., "edge_crypto", "regime_TREND")
 * @param {object} prior - Optional custom prior { alpha, beta }
 * @returns {{ key, alpha, beta, mean, mode, variance, updates }}
 */
export function initializePosterior(key, prior = null) {
  if (!posteriors[key]) {
    const p = prior || { ...DEFAULT_PRIOR };
    posteriors[key] = {
      alpha: p.alpha,
      beta: p.beta,
      updates: 0,
      history: [],
      createdAt: Date.now()
    };
  }

  return getPosteriorState(key);
}

/**
 * Update posterior with observed outcome.
 * Uses Beta-Binomial conjugate update: WIN → alpha+1, LOSS → beta+1.
 *
 * @param {string} key
 * @param {string} outcome - "WIN" or "LOSS"
 * @returns {{ posterior, shift, informationGain }}
 */
export function updatePosterior(key, outcome) {
  if (!posteriors[key]) initializePosterior(key);
  const p = posteriors[key];

  const priorMean = p.alpha / (p.alpha + p.beta);
  const priorEntropy = betaEntropy(p.alpha, p.beta);

  // Conjugate update
  if (outcome === "WIN") p.alpha += 1;
  else p.beta += 1;
  p.updates++;

  const posteriorMean = p.alpha / (p.alpha + p.beta);
  const posteriorEntropy = betaEntropy(p.alpha, p.beta);

  const shift = posteriorMean - priorMean;
  const informationGain = priorEntropy - posteriorEntropy;

  // Track history (keep last 50)
  p.history.push({
    outcome,
    mean: round4(posteriorMean),
    alpha: round2(p.alpha),
    beta: round2(p.beta),
    timestamp: Date.now()
  });
  if (p.history.length > 50) p.history = p.history.slice(-50);

  return {
    posterior: getPosteriorState(key),
    shift: round4(shift),
    informationGain: round4(informationGain),
    direction: shift > 0 ? "improving" : shift < 0 ? "degrading" : "stable"
  };
}

/**
 * Get credible interval for a posterior.
 *
 * @param {string} key
 * @param {number} credibility - 0.90 for 90% CI
 * @returns {{ lower, upper, mode, mean, width, entropy }}
 */
export function getCredibleInterval(key, credibility = 0.90) {
  if (!posteriors[key]) initializePosterior(key);
  const p = posteriors[key];

  const alpha = p.alpha;
  const beta = p.beta;
  const mean = alpha / (alpha + beta);
  const mode = (alpha > 1 && beta > 1) ? (alpha - 1) / (alpha + beta - 2) : mean;
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const std = Math.sqrt(variance);

  // Approximate credible interval using normal approximation
  const z = credibility === 0.99 ? 2.576 : credibility === 0.95 ? 1.96 : 1.645;
  const lower = Math.max(0, mean - z * std);
  const upper = Math.min(1, mean + z * std);

  return {
    key,
    credibility,
    lower: round4(lower),
    upper: round4(upper),
    width: round4(upper - lower),
    mean: round4(mean),
    mode: round4(mode),
    variance: round4(variance),
    entropy: round4(betaEntropy(alpha, beta)),
    updates: p.updates
  };
}

/**
 * Batch-calibrate posteriors from historical trade data.
 *
 * @param {number} days
 * @returns {{ calibrated, totalTrades }}
 */
export function calibrateFromHistory(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT sizing_method, regime, category, status
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
  `).all(daysOffset);

  if (rows.length < 10) {
    return { calibrated: [], totalTrades: 0, message: "insufficient_data" };
  }

  const counts = {};
  for (const r of rows) {
    // By method
    const methodKey = `method_${r.sizing_method || "default"}`;
    if (!counts[methodKey]) counts[methodKey] = { wins: 0, losses: 0 };
    if (r.status === "WIN") counts[methodKey].wins++;
    else counts[methodKey].losses++;

    // By regime
    const regimeKey = `regime_${r.regime || "unknown"}`;
    if (!counts[regimeKey]) counts[regimeKey] = { wins: 0, losses: 0 };
    if (r.status === "WIN") counts[regimeKey].wins++;
    else counts[regimeKey].losses++;

    // By category
    const catKey = `category_${r.category || "unknown"}`;
    if (!counts[catKey]) counts[catKey] = { wins: 0, losses: 0 };
    if (r.status === "WIN") counts[catKey].wins++;
    else counts[catKey].losses++;
  }

  const calibrated = [];
  for (const [key, data] of Object.entries(counts)) {
    if (data.wins + data.losses < 5) continue;

    // Set posterior directly from observed counts + weak prior
    posteriors[key] = {
      alpha: DEFAULT_PRIOR.alpha + data.wins,
      beta: DEFAULT_PRIOR.beta + data.losses,
      updates: data.wins + data.losses,
      history: [],
      createdAt: Date.now()
    };

    calibrated.push({
      key,
      wins: data.wins,
      losses: data.losses,
      posteriorMean: round4((DEFAULT_PRIOR.alpha + data.wins) / (DEFAULT_PRIOR.alpha + DEFAULT_PRIOR.beta + data.wins + data.losses)),
      ...getCredibleInterval(key, 0.90)
    });
  }

  calibrated.sort((a, b) => b.posteriorMean - a.posteriorMean);

  return {
    calibrated,
    totalTrades: rows.length,
    posteriorsCreated: calibrated.length,
    lookbackDays: days
  };
}

/**
 * Get all posteriors status.
 *
 * @returns {{ posteriors, totalUpdates, avgMean, mostConfident, leastConfident }}
 */
export function getPosteriorOverview() {
  const keys = Object.keys(posteriors);
  if (keys.length === 0) {
    return { posteriors: [], totalUpdates: 0, message: "no_posteriors" };
  }

  const states = keys.map(k => getPosteriorState(k));
  states.sort((a, b) => b.mean - a.mean);

  const totalUpdates = states.reduce((s, p) => s + p.updates, 0);
  const avgMean = states.reduce((s, p) => s + p.mean, 0) / states.length;

  return {
    posteriors: states.slice(0, 20),
    totalPosteriors: states.length,
    totalUpdates,
    avgMean: round4(avgMean),
    mostConfident: states[0] || null,
    leastConfident: states[states.length - 1] || null
  };
}

// Internal helpers

function getPosteriorState(key) {
  const p = posteriors[key];
  if (!p) return null;

  const alpha = p.alpha;
  const beta = p.beta;
  const total = alpha + beta;

  return {
    key,
    alpha: round2(alpha),
    beta: round2(beta),
    mean: round4(alpha / total),
    mode: alpha > 1 && beta > 1 ? round4((alpha - 1) / (total - 2)) : round4(alpha / total),
    variance: round4((alpha * beta) / (total ** 2 * (total + 1))),
    updates: p.updates,
    confidence: round3(Math.min(1, p.updates / 50)),
    entropy: round4(betaEntropy(alpha, beta))
  };
}

function betaEntropy(alpha, beta) {
  // Approximate entropy of Beta distribution
  const total = alpha + beta;
  if (total <= 0) return 0;
  const lnBeta = lnGamma(alpha) + lnGamma(beta) - lnGamma(total);
  return lnBeta - (alpha - 1) * (digamma(alpha) - digamma(total))
    - (beta - 1) * (digamma(beta) - digamma(total));
}

function lnGamma(x) {
  // Stirling's approximation
  if (x <= 0) return 0;
  return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI)
    + 1 / (12 * x);
}

function digamma(x) {
  // Approximation: psi(x) ≈ ln(x) - 1/(2x) for x > 6
  if (x < 6) {
    let result = 0;
    while (x < 6) { result -= 1 / x; x += 1; }
    return result + digamma(x);
  }
  return Math.log(x) - 1 / (2 * x) - 1 / (12 * x * x);
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
function round4(v) { return Math.round((v ?? 0) * 10000) / 10000; }
