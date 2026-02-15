/**
 * Composite signal quality score (0-100).
 * Combines confidence, edge, correlation, regime, streak, and hourly win rate
 * into a single quality metric used as a minimum gate for trade entry.
 */

/**
 * Compute a composite quality score for a signal.
 * @param {object} tick - Full tick from market-poller
 * @param {object} context - { streakMultiplier, hourMultiplier, regimeMultiplier }
 * @returns {{ quality: number, breakdown: object }}
 */
export function computeSignalQuality(tick, context = {}) {
  const breakdown = {};

  // 1. Confidence (0-100 → 0-30 points)
  const confidence = tick.confidence ?? 50;
  breakdown.confidence = Math.min(30, (confidence / 100) * 30);

  // 2. Edge magnitude (0-0.3+ → 0-25 points)
  const side = tick.rec?.side || "UP";
  const edgeVal = side === "UP" ? (tick.edge?.edgeUp ?? 0) : (tick.edge?.edgeDown ?? 0);
  const absEdge = Math.abs(edgeVal);
  breakdown.edge = Math.min(25, (absEdge / 0.15) * 25); // 15% edge = max points

  // 3. Correlation alignment (0.7-1.3 → 0-15 points)
  const corrAdj = tick.correlation?.adj ?? 1.0;
  // >1.0 = aligned (bonus), <1.0 = conflicting (penalty)
  breakdown.correlation = Math.min(15, Math.max(0, (corrAdj - 0.7) / 0.6 * 15));

  // 4. Regime favorability (0-12 points)
  const regime = tick.regimeInfo?.regime || "RANGE";
  const regimeScores = { TREND_UP: 12, TREND_DOWN: 12, RANGE: 6, CHOP: 0 };
  breakdown.regime = regimeScores[regime] ?? 6;

  // 5. Regime stability bonus (0-5 points) — rewards established regimes
  const stability = tick.regimeInfo?.stability ?? 50;
  breakdown.stability = Math.min(5, (stability / 100) * 5);

  // 6. Streak health (0-6 points)
  const streakMult = context.streakMultiplier ?? 1.0;
  breakdown.streak = Math.min(6, streakMult * 6);

  // 7. Hourly favorability (0-7 points)
  const hourMult = context.hourMultiplier ?? 1.0;
  breakdown.hourly = Math.min(7, hourMult * 6.36); // 1.1x → 7

  const quality = Math.round(
    breakdown.confidence + breakdown.edge + breakdown.correlation +
    breakdown.regime + breakdown.stability + breakdown.streak + breakdown.hourly
  );

  return {
    quality: Math.min(100, Math.max(0, quality)),
    breakdown
  };
}
