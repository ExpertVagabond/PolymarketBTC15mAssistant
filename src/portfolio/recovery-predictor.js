/**
 * Drawdown recovery & regime transition speed predictor.
 *
 * Estimates recovery timelines and risk-on signals:
 * - Time-to-recovery estimation from current drawdown
 * - Regime transition speed detection (sharp vs gradual)
 * - Recovery signal timing (when to resume normal trading)
 * - Pyramid re-entry level computation
 * - Historical recovery pattern matching
 *
 * Completes the drawdown management cycle from liquidation-forecaster.js.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Estimate time to recover from current drawdown.
 *
 * @param {number} days - Lookback for performance data
 * @returns {{ daysToBreakeven, confidence, paths, recommendation }}
 */
export function estimateRecoveryTime(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT date(created_at) as trade_date,
           SUM(realized_pnl) as daily_pnl,
           COUNT(*) as trades,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY trade_date
    ORDER BY trade_date
  `).all(daysOffset);

  if (rows.length < 5) {
    return { daysToBreakeven: null, confidence: 0, message: "insufficient_data" };
  }

  const dailyPnls = rows.map(r => r.daily_pnl);

  // Compute cumulative P&L to find current drawdown
  let cumPnl = 0, maxPnl = 0, currentDD = 0;
  for (const pnl of dailyPnls) {
    cumPnl += pnl;
    if (cumPnl > maxPnl) maxPnl = cumPnl;
    currentDD = maxPnl - cumPnl;
  }

  if (currentDD <= 0) {
    return {
      daysToBreakeven: 0,
      currentDrawdown: 0,
      confidence: 1,
      status: "at_high_water_mark",
      recommendation: "No recovery needed — portfolio at or above high water mark"
    };
  }

  // Average daily P&L (recent bias)
  const recentDays = dailyPnls.slice(-7);
  const avgDailyPnl = recentDays.reduce((s, v) => s + v, 0) / recentDays.length;
  const stdDailyPnl = stddev(recentDays);

  // Optimistic/pessimistic/base estimates
  let baseDays, optimisticDays, pessimisticDays;

  if (avgDailyPnl > 0) {
    baseDays = Math.ceil(currentDD / avgDailyPnl);
    optimisticDays = Math.ceil(currentDD / (avgDailyPnl + stdDailyPnl * 0.5));
    pessimisticDays = Math.ceil(currentDD / Math.max(0.01, avgDailyPnl - stdDailyPnl * 0.5));
  } else {
    baseDays = -1; // Not recovering at current rate
    optimisticDays = currentDD > 0 ? Math.ceil(currentDD / (stdDailyPnl * 0.3 || 1)) : 0;
    pessimisticDays = -1;
  }

  // Confidence: higher if recent performance is consistent and positive
  const winDays = dailyPnls.filter(p => p > 0).length;
  const consistency = winDays / dailyPnls.length;
  const confidence = round3(Math.min(1, consistency * (avgDailyPnl > 0 ? 1.5 : 0.3)));

  return {
    currentDrawdown: round2(currentDD),
    highWaterMark: round2(maxPnl),
    avgDailyPnl: round2(avgDailyPnl),
    daysToBreakeven: baseDays > 0 ? baseDays : null,
    paths: {
      optimistic: optimisticDays > 0 ? optimisticDays : null,
      base: baseDays > 0 ? baseDays : null,
      pessimistic: pessimisticDays > 0 ? pessimisticDays : null
    },
    confidence,
    status: avgDailyPnl > 0 ? "recovering" : "deepening",
    recommendation: avgDailyPnl > 0
      ? `Recovery estimated in ~${baseDays} days at current rate ($${round2(avgDailyPnl)}/day)`
      : "Drawdown deepening — consider reducing exposure until regime improves"
  };
}

/**
 * Detect regime transition speed.
 * Measures how fast the market shifts between regimes.
 *
 * @param {number} days
 * @returns {{ transitions, avgSpeed, sharpnessScore, reversalRisk }}
 */
export function detectRegimeTransitionSpeed(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT regime, created_at,
           strftime('%Y-%m-%d %H', created_at) as hour_bucket
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND regime IS NOT NULL
    ORDER BY created_at ASC
  `).all(daysOffset);

  if (rows.length < 10) {
    return { transitions: [], avgSpeed: 0, sharpnessScore: 0, message: "insufficient_data" };
  }

  // Detect regime changes
  const transitions = [];
  let prevRegime = rows[0].regime;
  let prevTime = rows[0].hour_bucket;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].regime !== prevRegime) {
      transitions.push({
        from: prevRegime,
        to: rows[i].regime,
        hourBucket: rows[i].hour_bucket,
        gapHours: hourDiff(prevTime, rows[i].hour_bucket)
      });
      prevRegime = rows[i].regime;
    }
    prevTime = rows[i].hour_bucket;
  }

  if (transitions.length === 0) {
    return {
      transitions: [],
      avgSpeed: 0,
      sharpnessScore: 0,
      currentRegime: prevRegime,
      stability: "very_stable",
      message: "no_transitions"
    };
  }

  // Average gap between transitions
  const gaps = transitions.map(t => t.gapHours).filter(g => g > 0);
  const avgGapHours = gaps.length > 0 ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0;

  // Sharpness: frequent transitions = sharp, rare = gradual
  const transitionsPerDay = transitions.length / Math.max(days, 1);
  const sharpnessScore = Math.min(100, Math.round(transitionsPerDay * 25));

  // Reversal risk: recent transitions
  const recent = transitions.slice(-3);
  const recentGaps = recent.map(t => t.gapHours).filter(g => g > 0);
  const recentAvg = recentGaps.length > 0 ? recentGaps.reduce((s, v) => s + v, 0) / recentGaps.length : 0;
  const reversalRisk = recentAvg < avgGapHours * 0.5 ? "high" : recentAvg < avgGapHours ? "moderate" : "low";

  return {
    transitions: transitions.slice(-10).map(t => ({
      from: t.from,
      to: t.to,
      gapHours: round2(t.gapHours)
    })),
    totalTransitions: transitions.length,
    avgGapHours: round2(avgGapHours),
    transitionsPerDay: round3(transitionsPerDay),
    sharpnessScore,
    stability: sharpnessScore > 60 ? "volatile" : sharpnessScore > 30 ? "moderate" : "stable",
    reversalRisk,
    currentRegime: rows[rows.length - 1].regime,
    lookbackDays: days
  };
}

/**
 * Generate recovery signal: should we resume normal trading?
 *
 * @param {number} days
 * @returns {{ resumeNow, confidence, conditions, suggestion }}
 */
export function getRecoverySignal(days = 14) {
  const recovery = estimateRecoveryTime(days);
  const transitions = detectRegimeTransitionSpeed(days);

  const conditions = [];
  let score = 0;

  // Condition 1: Positive recent P&L
  if (recovery.avgDailyPnl > 0) {
    conditions.push({ name: "positive_recent_pnl", met: true, weight: 30 });
    score += 30;
  } else {
    conditions.push({ name: "positive_recent_pnl", met: false, weight: 30 });
  }

  // Condition 2: Regime stability
  if (transitions.stability === "stable" || transitions.stability === "moderate") {
    conditions.push({ name: "regime_stable", met: true, weight: 25 });
    score += 25;
  } else {
    conditions.push({ name: "regime_stable", met: false, weight: 25 });
  }

  // Condition 3: Drawdown manageable
  const ddManageable = (recovery.currentDrawdown || 0) < 30;
  conditions.push({ name: "drawdown_manageable", met: ddManageable, weight: 25 });
  if (ddManageable) score += 25;

  // Condition 4: Low reversal risk
  const lowReversal = transitions.reversalRisk === "low";
  conditions.push({ name: "low_reversal_risk", met: lowReversal, weight: 20 });
  if (lowReversal) score += 20;

  const resumeNow = score >= 60;
  const confidence = round3(score / 100);

  let suggestion;
  if (score >= 80) suggestion = "full_risk_on";
  else if (score >= 60) suggestion = "partial_risk_on";
  else if (score >= 40) suggestion = "reduced_exposure";
  else suggestion = "risk_off";

  return {
    resumeNow,
    confidence,
    score,
    suggestion,
    conditions,
    currentDrawdown: recovery.currentDrawdown || 0,
    currentRegime: transitions.currentRegime || "unknown",
    regimeStability: transitions.stability || "unknown",
    recommendation: resumeNow
      ? `Resume trading at ${suggestion === "full_risk_on" ? "full" : "reduced"} size — conditions met`
      : `Hold — ${conditions.filter(c => !c.met).map(c => c.name).join(", ")} not satisfied`
  };
}

/**
 * Compute pyramid re-entry levels for underwater positions.
 *
 * @param {number} currentDrawdown - Current drawdown in dollars
 * @param {string} regime
 * @returns {{ levels, maxExposure, strategy }}
 */
export function computePyramidLevels(currentDrawdown = 10, regime = "RANGE") {
  const dd = Math.abs(currentDrawdown);

  // Regime-based aggressiveness
  const aggressiveness = {
    TREND_UP: 1.3,
    TREND_DOWN: 0.5,
    RANGE: 1.0,
    CHOP: 0.3
  }[regime] || 0.7;

  // Define re-entry levels
  const levels = [
    { depth: 0.25, sizePct: 0.15 * aggressiveness, trigger: "25% of DD recovered" },
    { depth: 0.50, sizePct: 0.25 * aggressiveness, trigger: "50% of DD recovered" },
    { depth: 0.75, sizePct: 0.35 * aggressiveness, trigger: "75% of DD recovered" },
    { depth: 1.00, sizePct: 0.25 * aggressiveness, trigger: "Full DD recovered" }
  ].map(l => ({
    recoveryPct: round3(l.depth),
    dollarLevel: round2(dd * l.depth),
    positionSizePct: round3(Math.min(0.50, l.sizePct)),
    triggerCondition: l.trigger
  }));

  const maxExposure = round3(levels.reduce((s, l) => s + l.positionSizePct, 0));

  let strategy;
  if (regime === "CHOP" || regime === "TREND_DOWN") {
    strategy = "conservative_pyramid";
  } else if (aggressiveness > 1) {
    strategy = "aggressive_pyramid";
  } else {
    strategy = "standard_pyramid";
  }

  return {
    levels,
    maxExposure,
    strategy,
    regime,
    currentDrawdown: round2(dd),
    recommendation: aggressiveness < 0.5
      ? "Hostile regime — minimal re-entry, wait for regime change"
      : `${strategy}: scale back in at ${levels.length} levels, max ${round3(maxExposure * 100)}% exposure`
  };
}

/**
 * Get full recovery dashboard.
 *
 * @returns {{ recovery, transitions, signal, pyramid }}
 */
export function getRecoveryDashboard() {
  const recovery = estimateRecoveryTime();
  const transitions = detectRegimeTransitionSpeed();
  const signal = getRecoverySignal();
  const pyramid = computePyramidLevels(
    recovery.currentDrawdown || 10,
    transitions.currentRegime || "RANGE"
  );

  return {
    status: recovery.status || "unknown",
    currentDrawdown: recovery.currentDrawdown || 0,
    daysToBreakeven: recovery.daysToBreakeven,
    regime: transitions.currentRegime || "unknown",
    regimeStability: transitions.stability || "unknown",
    resumeTrading: signal.resumeNow,
    tradingSuggestion: signal.suggestion,
    recoveryConfidence: signal.confidence,
    pyramidStrategy: pyramid.strategy,
    pyramidLevels: pyramid.levels.length,
    recommendation: signal.recommendation
  };
}

// Helpers

function hourDiff(a, b) {
  try {
    const da = new Date(a.replace(" ", "T") + ":00:00Z");
    const db = new Date(b.replace(" ", "T") + ":00:00Z");
    return Math.abs(db - da) / 3600000;
  } catch {
    return 0;
  }
}

function stddev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
