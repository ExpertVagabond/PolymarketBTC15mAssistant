/**
 * Kelly criterion position sizing engine.
 *
 * Recommends optimal bet size based on edge, win probability, and odds.
 * Uses fractional Kelly (half or quarter) for conservative sizing.
 *
 * For binary Polymarket outcomes:
 * - You buy YES at price p, payout is 1.0 if YES wins → odds = (1-p)/p
 * - You buy NO at price p, payout is 1.0 if NO wins → odds = (1-p)/p
 *
 * Kelly fraction = (bp - q) / b
 * where b = net odds (payout ratio), p = win probability, q = 1-p
 *
 * We use model probability as win probability, and market price for odds.
 */

import { clamp } from "../utils.js";
import { getSignalStats } from "../signals/history.js";

/**
 * Compute Kelly fraction for a binary market position.
 *
 * @param {number} modelProb  - Model's estimated probability of winning (0-1)
 * @param {number} marketPrice - Market price you'd buy at (0-1, e.g., 0.50 for 50c)
 * @param {object} opts
 * @param {number} opts.fraction   - Kelly fraction: 1.0 = full, 0.5 = half, 0.25 = quarter
 * @param {number} opts.maxBetPct  - Maximum position size as % of bankroll (cap)
 * @param {number} opts.minEdge    - Minimum edge required (below this = 0 bet)
 * @returns {{ kellyFull: number, kellyFraction: number, betPct: number, edge: number, odds: number }}
 */
export function computeKelly(modelProb, marketPrice, opts = {}) {
  const fraction = opts.fraction ?? 0.25;  // Quarter-Kelly default (conservative)
  const maxBetPct = opts.maxBetPct ?? 0.05; // Max 5% of bankroll
  const minEdge = opts.minEdge ?? 0.02;     // Need at least 2% edge

  // Validation
  if (modelProb == null || marketPrice == null) {
    return { kellyFull: 0, kellyFraction: 0, betPct: 0, edge: 0, odds: 0, reason: "missing_data" };
  }

  if (marketPrice <= 0 || marketPrice >= 1) {
    return { kellyFull: 0, kellyFraction: 0, betPct: 0, edge: 0, odds: 0, reason: "invalid_price" };
  }

  // Net odds: what you win per dollar risked
  // Buy at 50c, win = $1 payout → net profit = 50c → odds = 1.0
  // Buy at 30c, win = $1 payout → net profit = 70c → odds = 2.33
  const odds = (1 - marketPrice) / marketPrice;

  // Edge: model prob - market implied prob
  const edge = modelProb - marketPrice;

  if (edge < minEdge) {
    return { kellyFull: 0, kellyFraction: 0, betPct: 0, edge, odds, reason: "insufficient_edge" };
  }

  // Kelly formula: f* = (bp - q) / b
  // where b = odds, p = modelProb, q = 1 - modelProb
  const kellyFull = (odds * modelProb - (1 - modelProb)) / odds;

  if (kellyFull <= 0) {
    return { kellyFull: 0, kellyFraction: 0, betPct: 0, edge, odds, reason: "negative_kelly" };
  }

  // Apply fractional Kelly and cap
  const kellyFrac = kellyFull * fraction;
  const betPct = clamp(kellyFrac, 0, maxBetPct);

  return {
    kellyFull: Math.round(kellyFull * 10000) / 10000,
    kellyFraction: Math.round(kellyFrac * 10000) / 10000,
    betPct: Math.round(betPct * 10000) / 10000,
    edge: Math.round(edge * 10000) / 10000,
    odds: Math.round(odds * 100) / 100,
    reason: "ok"
  };
}

/**
 * Compute Kelly sizing for a signal tick, using both model and historical performance.
 *
 * Adjusts the Kelly fraction based on historical win rate:
 * - Win rate > 60% → use half-Kelly (aggressive)
 * - Win rate 50-60% → use quarter-Kelly (moderate)
 * - Win rate < 50% or unknown → use eighth-Kelly (conservative)
 * - < 20 settled signals → use eighth-Kelly (insufficient data)
 *
 * @param {object} tick - Full tick from market poller
 * @returns {{ kelly: object, sizingTier: string }}
 */
export function computeSignalKelly(tick) {
  if (!tick.rec || tick.rec.action !== "ENTER") {
    return {
      kelly: { kellyFull: 0, kellyFraction: 0, betPct: 0, edge: 0, odds: 0, reason: "no_signal" },
      sizingTier: "NONE"
    };
  }

  const side = tick.rec.side;
  const modelProb = side === "UP" ? tick.timeAware?.adjustedUp : tick.timeAware?.adjustedDown;
  const marketPrice = side === "UP" ? tick.prices?.up : tick.prices?.down;

  // Determine Kelly fraction from historical performance
  let fraction = 0.125; // Eighth-Kelly default (very conservative)
  let sizingTier = "CONSERVATIVE";

  try {
    const stats = getSignalStats();
    const settled = (stats.wins || 0) + (stats.losses || 0);

    if (settled >= 20) {
      const winRate = stats.wins / settled;
      if (winRate >= 0.60) {
        fraction = 0.5;
        sizingTier = "AGGRESSIVE";
      } else if (winRate >= 0.50) {
        fraction = 0.25;
        sizingTier = "MODERATE";
      } else {
        fraction = 0.125;
        sizingTier = "CONSERVATIVE";
      }
    }
  } catch {
    // Use default conservative sizing
  }

  // Confidence adjustment: scale fraction by confidence if available
  const confidence = tick.confidence;
  if (confidence != null && confidence < 70) {
    // Below 70 confidence, scale down further
    fraction *= confidence / 70;
  }

  const kelly = computeKelly(modelProb, marketPrice, {
    fraction,
    maxBetPct: 0.05,
    minEdge: 0.02
  });

  return { kelly, sizingTier };
}
