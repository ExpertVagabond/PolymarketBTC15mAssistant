/**
 * Regime-adaptive position sizing engine.
 *
 * Dynamic multiplier for Kelly position sizing based on:
 * - Current market regime (TREND = boost, CHOP = reduce)
 * - Portfolio correlation load (high correlation = reduce)
 * - Time-of-day performance patterns (cold hours = reduce)
 * - Ensemble model agreement (high agreement = boost)
 *
 * Multiplier range: 0.3x to 1.5x applied to base Kelly fraction.
 */

import { getDb } from "../subscribers/db.js";

// Regime multipliers — trade aggressively in trends, cautiously in chop
const REGIME_MULTIPLIER = {
  TREND_UP:   1.2,
  TREND_DOWN: 1.1,
  RANGE:      1.0,
  CHOP:       0.6
};

// Hour-of-day performance adjustments (UTC)
// Populated from historical data; null = use 1.0
let hourMultipliers = {};
let lastHourCalc = 0;

/**
 * Get the regime-adaptive sizing multiplier.
 *
 * @param {object} tick - Signal tick with regime, hour, confidence, category
 * @param {object} opts
 * @param {number} opts.portfolioBeta - Current portfolio beta (from hedge-engine)
 * @param {number} opts.correlationLoad - Number of correlated open positions
 * @param {number} opts.ensembleAgreement - Model agreement score (0-1)
 * @returns {{ multiplier, components, recommendation }}
 */
export function getRegimeSizingMultiplier(tick, opts = {}) {
  const regime = tick?.regime || "RANGE";
  const hour = tick?.hour ?? new Date().getUTCHours();

  // 1. Regime component
  const regimeComp = REGIME_MULTIPLIER[regime] ?? 1.0;

  // 2. Portfolio beta component: reduce when over-leveraged
  const beta = opts.portfolioBeta ?? 1.0;
  const betaComp = beta > 2.0 ? 0.5
    : beta > 1.5 ? 0.7
    : beta > 1.2 ? 0.85
    : 1.0;

  // 3. Correlation load component: reduce with many correlated positions
  const corrLoad = opts.correlationLoad ?? 0;
  const corrComp = corrLoad >= 4 ? 0.5
    : corrLoad >= 3 ? 0.7
    : corrLoad >= 2 ? 0.85
    : 1.0;

  // 4. Time-of-day component from historical performance
  const hourComp = getHourMultiplier(hour);

  // 5. Ensemble agreement component: boost when models agree
  const agreement = opts.ensembleAgreement ?? 0.5;
  const agreementComp = agreement >= 0.8 ? 1.15
    : agreement >= 0.6 ? 1.05
    : agreement >= 0.4 ? 1.0
    : 0.85;

  // Composite: geometric mean-ish weighted combination
  const raw = regimeComp * betaComp * corrComp * hourComp * agreementComp;
  const multiplier = Math.round(Math.max(0.3, Math.min(1.5, raw)) * 100) / 100;

  // Recommendation
  let recommendation = "normal";
  if (multiplier >= 1.2) recommendation = "aggressive";
  else if (multiplier >= 0.9) recommendation = "normal";
  else if (multiplier >= 0.6) recommendation = "cautious";
  else recommendation = "minimal";

  return {
    multiplier,
    recommendation,
    components: {
      regime: { value: regime, multiplier: regimeComp },
      beta: { value: Math.round(beta * 100) / 100, multiplier: betaComp },
      correlation: { value: corrLoad, multiplier: corrComp },
      hour: { value: hour, multiplier: hourComp },
      agreement: { value: Math.round(agreement * 100) / 100, multiplier: agreementComp }
    }
  };
}

/**
 * Get full sizing profile: current state of all adaptive components.
 * @returns {object}
 */
export function getSizingProfile() {
  refreshHourMultipliers();

  return {
    regimeMultipliers: { ...REGIME_MULTIPLIER },
    hourMultipliers: { ...hourMultipliers },
    limits: { min: 0.3, max: 1.5 },
    recommendations: {
      aggressive: ">= 1.2x",
      normal: "0.9x - 1.2x",
      cautious: "0.6x - 0.9x",
      minimal: "< 0.6x"
    }
  };
}

/**
 * Get the hour-of-day multiplier based on historical win rates.
 * Hours with >55% win rate get a boost; <40% get a reduction.
 */
function getHourMultiplier(hour) {
  refreshHourMultipliers();
  return hourMultipliers[hour] ?? 1.0;
}

function refreshHourMultipliers() {
  const now = Date.now();
  if (now - lastHourCalc < 30 * 60 * 1000) return; // Refresh every 30 min
  lastHourCalc = now;

  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT strftime('%H', created_at) as hour,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses
      FROM trade_executions
      WHERE outcome IN ('WIN', 'LOSS') AND created_at > datetime('now', '-30 days')
      GROUP BY hour
    `).all();

    hourMultipliers = {};
    for (const r of rows) {
      const h = parseInt(r.hour);
      const total = r.wins + r.losses;
      if (total < 5) continue;
      const winRate = r.wins / total;
      // Map win rate to multiplier: 50% = 1.0, 65%+ = 1.15, 35%- = 0.75
      if (winRate >= 0.65) hourMultipliers[h] = 1.15;
      else if (winRate >= 0.55) hourMultipliers[h] = 1.05;
      else if (winRate >= 0.45) hourMultipliers[h] = 1.0;
      else if (winRate >= 0.35) hourMultipliers[h] = 0.85;
      else hourMultipliers[h] = 0.75;
    }
  } catch {
    // No DB yet — all hours default to 1.0
  }
}
