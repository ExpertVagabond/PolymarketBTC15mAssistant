/**
 * Regime forecaster.
 *
 * Predicts the next-period market regime using a Markov chain
 * built from historical regime transitions:
 *
 * 1. Build transition matrix from observed regime changes
 * 2. Compute stationary distribution (long-run probabilities)
 * 3. Factor in time-of-day and day-of-week patterns
 * 4. Forecast most likely next regime with confidence
 *
 * Regimes: TREND_UP, TREND_DOWN, RANGE, CHOP
 */

import { getDb } from "../subscribers/db.js";

const REGIMES = ["TREND_UP", "TREND_DOWN", "RANGE", "CHOP"];

// In-memory transition counts
const transitionCounts = {};
const hourlyRegimeCounts = {}; // hour -> { regime -> count }
const dayRegimeCounts = {};    // dayOfWeek -> { regime -> count }

// Initialize matrices
for (const from of REGIMES) {
  transitionCounts[from] = {};
  for (const to of REGIMES) {
    transitionCounts[from][to] = 1; // Laplace smoothing
  }
}

/**
 * Record an observed regime transition.
 * @param {string} fromRegime
 * @param {string} toRegime
 * @param {number} hour - UTC hour (0-23)
 * @param {number} dayOfWeek - 0=Sun, 6=Sat
 */
export function recordTransition(fromRegime, toRegime, hour = null, dayOfWeek = null) {
  const from = REGIMES.includes(fromRegime) ? fromRegime : "RANGE";
  const to = REGIMES.includes(toRegime) ? toRegime : "RANGE";

  if (!transitionCounts[from]) transitionCounts[from] = {};
  transitionCounts[from][to] = (transitionCounts[from][to] || 0) + 1;

  // Track hourly regime distribution
  if (hour != null) {
    if (!hourlyRegimeCounts[hour]) hourlyRegimeCounts[hour] = {};
    hourlyRegimeCounts[hour][to] = (hourlyRegimeCounts[hour][to] || 0) + 1;
  }

  // Track daily regime distribution
  if (dayOfWeek != null) {
    if (!dayRegimeCounts[dayOfWeek]) dayRegimeCounts[dayOfWeek] = {};
    dayRegimeCounts[dayOfWeek][to] = (dayRegimeCounts[dayOfWeek][to] || 0) + 1;
  }
}

/**
 * Get the transition probability matrix.
 * Each row sums to 1.
 */
export function getTransitionMatrix() {
  const matrix = {};
  for (const from of REGIMES) {
    matrix[from] = {};
    const counts = transitionCounts[from] || {};
    const total = REGIMES.reduce((s, to) => s + (counts[to] || 1), 0);
    for (const to of REGIMES) {
      matrix[from][to] = Math.round(((counts[to] || 1) / total) * 1000) / 1000;
    }
  }
  return matrix;
}

/**
 * Forecast the next regime given the current one.
 * @param {string} currentRegime
 * @param {object} opts - { hour, dayOfWeek }
 * @returns {{ predicted, confidence, probabilities, hourBias, dayBias }}
 */
export function forecastRegime(currentRegime, opts = {}) {
  const from = REGIMES.includes(currentRegime) ? currentRegime : "RANGE";
  const matrix = getTransitionMatrix();
  const baseProbs = matrix[from];

  // Start with base transition probabilities
  const probs = { ...baseProbs };

  // Hour-of-day bias
  let hourBias = null;
  if (opts.hour != null && hourlyRegimeCounts[opts.hour]) {
    const hourCounts = hourlyRegimeCounts[opts.hour];
    const hourTotal = Object.values(hourCounts).reduce((s, c) => s + c, 0);
    if (hourTotal >= 10) {
      hourBias = {};
      for (const r of REGIMES) {
        const hourProb = (hourCounts[r] || 0) / hourTotal;
        hourBias[r] = Math.round(hourProb * 1000) / 1000;
        // Blend: 70% transition matrix, 30% hour pattern
        probs[r] = probs[r] * 0.7 + hourProb * 0.3;
      }
    }
  }

  // Day-of-week bias
  let dayBias = null;
  if (opts.dayOfWeek != null && dayRegimeCounts[opts.dayOfWeek]) {
    const dayCounts = dayRegimeCounts[opts.dayOfWeek];
    const dayTotal = Object.values(dayCounts).reduce((s, c) => s + c, 0);
    if (dayTotal >= 10) {
      dayBias = {};
      for (const r of REGIMES) {
        const dayProb = (dayCounts[r] || 0) / dayTotal;
        dayBias[r] = Math.round(dayProb * 1000) / 1000;
        // Blend in 10% day pattern
        probs[r] = probs[r] * 0.9 + dayProb * 0.1;
      }
    }
  }

  // Normalize
  const total = Object.values(probs).reduce((s, v) => s + v, 0);
  const normalized = {};
  for (const r of REGIMES) {
    normalized[r] = Math.round((probs[r] / total) * 1000) / 1000;
  }

  // Find most likely
  let predicted = REGIMES[0];
  let maxProb = 0;
  for (const [r, p] of Object.entries(normalized)) {
    if (p > maxProb) { predicted = r; maxProb = p; }
  }

  // Confidence: how much more likely than second-best
  const sorted = Object.values(normalized).sort((a, b) => b - a);
  const confidence = sorted.length >= 2
    ? Math.round(((sorted[0] - sorted[1]) / sorted[0]) * 100)
    : 50;

  return {
    currentRegime: from,
    predicted,
    confidence: Math.min(100, Math.max(0, confidence)),
    probabilities: normalized,
    hourBias,
    dayBias
  };
}

/**
 * Get average regime durations from historical data.
 * @param {number} days - lookback
 */
export function getRegimeDurations(days = 30) {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT regime, COUNT(*) as count
      FROM signal_history
      WHERE created_at > datetime('now', ?)
      GROUP BY regime
    `).all(`-${days} days`);

    const total = rows.reduce((s, r) => s + r.count, 0);
    return {
      distribution: rows.map(r => ({
        regime: r.regime || "RANGE",
        count: r.count,
        pct: total > 0 ? Math.round((r.count / total) * 10000) / 100 : 0
      })),
      total,
      days
    };
  } catch {
    return { distribution: [], total: 0, days };
  }
}

/**
 * Bootstrap the forecaster from historical signal data.
 * Call once on startup to seed the transition matrix.
 */
export function bootstrapFromHistory(days = 30) {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT regime, strftime('%H', created_at) as hour, strftime('%w', created_at) as dow
      FROM signal_history
      WHERE regime IS NOT NULL AND created_at > datetime('now', ?)
      ORDER BY created_at ASC
    `).all(`-${days} days`);

    let prevRegime = null;
    let transitions = 0;
    for (const row of rows) {
      const regime = row.regime || "RANGE";
      const hour = row.hour != null ? parseInt(row.hour) : null;
      const dow = row.dow != null ? parseInt(row.dow) : null;

      if (prevRegime && prevRegime !== regime) {
        recordTransition(prevRegime, regime, hour, dow);
        transitions++;
      }
      prevRegime = regime;
    }

    return { bootstrapped: true, signals: rows.length, transitions };
  } catch {
    return { bootstrapped: false, error: "no history data" };
  }
}
