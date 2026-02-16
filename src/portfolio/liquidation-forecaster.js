/**
 * Liquidation risk forecaster.
 *
 * Monte Carlo simulation predicting probability of breaching the daily
 * loss limit within various time horizons (4h, 8h, 24h).
 *
 * Method:
 * 1. Estimate per-trade P&L volatility from recent history
 * 2. Estimate trade frequency (trades per hour)
 * 3. Simulate N paths of future P&L using random walk with drift
 * 4. Count how many paths cross the circuit breaker threshold
 * 5. Recommend position trims if breach probability is high
 */

import { getDb } from "../subscribers/db.js";
import { getRiskStatus } from "../trading/risk-manager.js";
import { getOpenExecutions } from "../trading/execution-log.js";

const SIMULATIONS = 500;
const HORIZONS = [4, 8, 24]; // hours

/**
 * Forecast liquidation risk across multiple time horizons.
 * @returns {{ horizons: object[], currentRisk: object, recommendations: string[] }}
 */
export function forecastLiquidationRisk() {
  const risk = getRiskStatus();
  const dailyPnl = risk.dailyPnl || 0;
  const dailyLimit = risk.dailyLossLimit || 25;
  const remainingBudget = dailyLimit + dailyPnl; // How much more we can lose

  // Get recent trade P&L distribution
  const { avgPnl, stdPnl, tradesPerHour } = getTradeVolatility(7);

  if (tradesPerHour === 0 || stdPnl === 0) {
    return {
      horizons: HORIZONS.map(h => ({ hours: h, breachProbability: 0, insufficientData: true })),
      currentRisk: { dailyPnl: round2(dailyPnl), dailyLimit, remainingBudget: round2(remainingBudget), pctUsed: round1(Math.abs(dailyPnl) / dailyLimit * 100) },
      recommendations: [],
      simulations: SIMULATIONS
    };
  }

  const horizons = HORIZONS.map(hours => {
    const expectedTrades = Math.max(1, Math.round(tradesPerHour * hours));
    let breaches = 0;
    let worstPath = 0;
    let avgFinalPnl = 0;

    for (let i = 0; i < SIMULATIONS; i++) {
      let cumPnl = dailyPnl;
      let pathWorst = cumPnl;

      for (let t = 0; t < expectedTrades; t++) {
        // Box-Muller transform for normal random
        const u1 = Math.random();
        const u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const tradePnl = avgPnl + stdPnl * z;
        cumPnl += tradePnl;
        pathWorst = Math.min(pathWorst, cumPnl);
      }

      if (pathWorst <= -dailyLimit) breaches++;
      if (pathWorst < worstPath) worstPath = pathWorst;
      avgFinalPnl += cumPnl;
    }

    avgFinalPnl /= SIMULATIONS;

    return {
      hours,
      expectedTrades,
      breachProbability: Math.round((breaches / SIMULATIONS) * 1000) / 10,
      worstCasePnl: round2(worstPath),
      avgFinalPnl: round2(avgFinalPnl),
      breachCount: breaches
    };
  });

  // Recommendations
  const recommendations = [];
  const openPositions = getOpenExecutions().length;
  const p4h = horizons.find(h => h.hours === 4)?.breachProbability || 0;

  if (p4h > 50) {
    recommendations.push(`HIGH RISK: ${p4h}% breach probability in 4h. Consider pausing trading or closing ${Math.ceil(openPositions * 0.5)} positions.`);
  } else if (p4h > 25) {
    recommendations.push(`ELEVATED: ${p4h}% breach probability in 4h. Consider reducing position sizes by 30%.`);
  } else if (p4h > 10) {
    recommendations.push(`MODERATE: ${p4h}% breach probability in 4h. Monitor closely.`);
  }

  if (remainingBudget < dailyLimit * 0.25) {
    recommendations.push(`Budget warning: only $${round2(remainingBudget)} remaining (${round1((remainingBudget / dailyLimit) * 100)}% of limit).`);
  }

  return {
    horizons,
    currentRisk: {
      dailyPnl: round2(dailyPnl),
      dailyLimit,
      remainingBudget: round2(remainingBudget),
      pctUsed: round1(Math.abs(dailyPnl) / dailyLimit * 100),
      openPositions,
      circuitBroken: risk.circuitBroken || false
    },
    recommendations,
    model: {
      avgPnlPerTrade: round4(avgPnl),
      stdPnlPerTrade: round4(stdPnl),
      tradesPerHour: round2(tradesPerHour)
    },
    simulations: SIMULATIONS
  };
}

/**
 * Quick breach probability for a single horizon.
 * @param {number} hours
 * @returns {{ probability: number, hours }}
 */
export function getBreachProbability(hours = 4) {
  const result = forecastLiquidationRisk();
  const h = result.horizons.find(x => x.hours === hours) || result.horizons[0];
  return {
    probability: h?.breachProbability || 0,
    hours: h?.hours || hours,
    currentPnl: result.currentRisk.dailyPnl,
    limit: result.currentRisk.dailyLimit
  };
}

/**
 * Get trade P&L volatility from recent history.
 */
function getTradeVolatility(days = 7) {
  try {
    const db = getDb();
    const trades = db.prepare(`
      SELECT pnl_usd, created_at
      FROM trade_executions
      WHERE outcome IN ('WIN', 'LOSS') AND pnl_usd IS NOT NULL
        AND created_at > datetime('now', ?)
      ORDER BY created_at ASC
    `).all(`-${days} days`);

    if (trades.length < 5) return { avgPnl: 0, stdPnl: 0, tradesPerHour: 0 };

    const pnls = trades.map(t => t.pnl_usd);
    const avgPnl = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    const variance = pnls.reduce((s, v) => s + (v - avgPnl) ** 2, 0) / pnls.length;
    const stdPnl = Math.sqrt(variance);

    // Trades per hour
    const first = new Date(trades[0].created_at).getTime();
    const last = new Date(trades[trades.length - 1].created_at).getTime();
    const hourSpan = Math.max(1, (last - first) / (1000 * 60 * 60));
    const tradesPerHour = trades.length / hourSpan;

    return { avgPnl, stdPnl, tradesPerHour };
  } catch {
    return { avgPnl: 0, stdPnl: 0, tradesPerHour: 0 };
  }
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
