/**
 * Unified confidence scoring engine.
 *
 * Produces a single 0-100 confidence score for each signal by combining:
 * - Indicator agreement (how many indicators point the same direction)
 * - Multi-timeframe confluence (1m/5m/15m alignment)
 * - BTC correlation alignment (macro supports the trade)
 * - Volatility regime (low vol = more predictable)
 * - Order flow alignment (orderbook supports the trade)
 * - Time decay factor (closer to indicator horizon = better)
 * - Regime quality (trend = better than chop)
 * - Edge magnitude (bigger edge = more confident)
 *
 * The confidence score gates signal display and Kelly sizing:
 * 80-100: High confidence — prominent display, larger Kelly fraction
 * 60-79:  Medium confidence — normal display, moderate Kelly
 * 40-59:  Low confidence — muted display, small Kelly
 * 0-39:   Very low — signal may be suppressed entirely
 */

import { clamp } from "../utils.js";

/**
 * Compute confidence score for a signal tick.
 *
 * @param {object} tick - Full tick from market poller (must have rec.action === "ENTER")
 * @param {object} opts - Optional overrides for testing
 * @returns {{ score: number, tier: string, breakdown: object }}
 */
export function computeConfidence(tick, opts = {}) {
  const breakdown = {};
  let total = 0;
  let maxPossible = 0;

  // ── 1. Edge magnitude (0-20 points) ──
  // Bigger edge = more mispricing = higher confidence
  const side = tick.rec?.side;
  const edge = side === "UP" ? tick.edge?.edgeUp : tick.edge?.edgeDown;
  if (edge != null) {
    // 5% edge = 10pts, 10% = 15pts, 20%+ = 20pts
    const edgePts = clamp(edge * 100, 0, 20);
    breakdown.edge = Math.round(edgePts * 10) / 10;
    total += edgePts;
  }
  maxPossible += 20;

  // ── 2. Indicator agreement (0-20 points) ──
  // How many of the 6 core indicators agree with the signal direction
  const scored = tick.scored;
  if (scored && !scored.degenerate) {
    const majorScore = side === "UP" ? scored.upScore : scored.downScore;
    const minorScore = side === "UP" ? scored.downScore : scored.upScore;
    // Score ratio: 10/2 = 5x agreement, 6/5 = barely
    const ratio = minorScore > 0 ? majorScore / minorScore : majorScore;
    // Ratio of 2+ is solid, 3+ is strong
    const agreementPts = clamp((ratio - 1) * 8, 0, 20);
    breakdown.indicators = Math.round(agreementPts * 10) / 10;
    total += agreementPts;
  } else if (scored?.degenerate) {
    // Degenerate indicators get minimal points
    breakdown.indicators = 2;
    total += 2;
  }
  maxPossible += 20;

  // ── 3. Multi-timeframe confluence (0-15 points) ──
  const conf = tick.confluence;
  if (conf) {
    const confAligned = conf.direction === (side === "UP" ? "UP" : "DOWN");
    if (conf.score >= 3 && confAligned) {
      breakdown.confluence = 15;
    } else if (conf.score >= 2 && confAligned) {
      breakdown.confluence = 10;
    } else if (conf.score >= 1 && confAligned) {
      breakdown.confluence = 5;
    } else if (!confAligned && conf.score >= 2) {
      breakdown.confluence = -5; // Conflicting = penalty
    } else {
      breakdown.confluence = 0;
    }
    total += breakdown.confluence;
  }
  maxPossible += 15;

  // ── 4. BTC correlation alignment (0-10 points) ──
  const corr = tick.correlation;
  if (corr && corr.adj != null) {
    if (corr.adj > 1.1) {
      breakdown.correlation = 10;
    } else if (corr.adj > 1.0) {
      breakdown.correlation = 5;
    } else if (corr.adj < 0.9) {
      breakdown.correlation = -5; // BTC conflicts
    } else if (corr.adj < 1.0) {
      breakdown.correlation = -2;
    } else {
      breakdown.correlation = 0;
    }
    total += breakdown.correlation;
  }
  maxPossible += 10;

  // ── 5. Volatility regime (0-10 points) ──
  const vol = tick.volRegime;
  if (vol) {
    if (vol === "LOW_VOL") {
      // Low vol = more predictable = higher confidence
      breakdown.volatility = 10;
    } else if (vol === "NORMAL_VOL") {
      breakdown.volatility = 6;
    } else if (vol === "HIGH_VOL") {
      // High vol = less predictable = lower confidence
      breakdown.volatility = 2;
    }
    total += breakdown.volatility;
  }
  maxPossible += 10;

  // ── 6. Order flow (0-15 points) ──
  const flow = tick.orderFlow;
  if (flow) {
    if (flow.flowSupports && flow.flowQuality !== "THIN") {
      // Order flow supports the signal with decent depth
      const flowPts = flow.flowQuality === "DEEP" ? 15
        : flow.alignedScore > 30 ? 12
        : 8;
      breakdown.orderFlow = flowPts;
    } else if (flow.flowConflicts) {
      breakdown.orderFlow = -5;
    } else {
      breakdown.orderFlow = 0;
    }
    total += breakdown.orderFlow;
  }
  maxPossible += 15;

  // ── 7. Time decay (0-5 points) ──
  const timeDecay = tick.timeAware?.timeDecay;
  if (timeDecay != null) {
    // Peak confidence when decay is 0.6-0.9 (not too close, not too far)
    if (timeDecay >= 0.6 && timeDecay <= 0.9) {
      breakdown.timeDecay = 5;
    } else if (timeDecay >= 0.4) {
      breakdown.timeDecay = 3;
    } else if (timeDecay >= 0.2) {
      breakdown.timeDecay = 1;
    } else {
      breakdown.timeDecay = 0;
    }
    total += breakdown.timeDecay;
  }
  maxPossible += 5;

  // ── 8. Regime quality (0-5 points) ──
  const regime = tick.regimeInfo?.regime;
  if (regime) {
    if (regime === "TREND_UP" && side === "UP") {
      breakdown.regime = 5;
    } else if (regime === "TREND_DOWN" && side === "DOWN") {
      breakdown.regime = 5;
    } else if (regime === "RANGE") {
      breakdown.regime = 2;
    } else if (regime === "CHOP") {
      breakdown.regime = -3;
    } else {
      breakdown.regime = 0;
    }
    total += breakdown.regime;
  }
  maxPossible += 5;

  // ── Normalize to 0-100 ──
  // Total can be negative from penalties; floor at 0
  const rawScore = Math.max(0, total);
  // Scale to 0-100 based on max possible points
  const score = maxPossible > 0
    ? Math.round(clamp((rawScore / maxPossible) * 100, 0, 100))
    : 0;

  // Tier classification
  let tier;
  if (score >= 80) tier = "HIGH";
  else if (score >= 60) tier = "MEDIUM";
  else if (score >= 40) tier = "LOW";
  else tier = "VERY_LOW";

  return { score, tier, breakdown, rawPoints: Math.round(total * 10) / 10, maxPoints: maxPossible };
}
