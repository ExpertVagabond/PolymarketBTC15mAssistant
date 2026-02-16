/**
 * Predictive circuit breaker.
 *
 * Goes beyond static loss thresholds to preemptively halt trading:
 * - Regime-aware thresholds: tighter in CHOP, looser in TREND
 * - Breach probability gates: halt when 4h breach prob > 40%
 * - Volatility-gated entry: block new trades when vol exceeds 90th pct
 * - Position heat tracking: monitor unrealized P&L volatility
 * - Automatic trim triggers: reduce exposure incrementally
 *
 * Integrates with liquidation-forecaster for Monte Carlo breach forecasts
 * and volatility-surface for real-time vol regime assessment.
 */

import { getDb } from "../subscribers/db.js";

// State
const breakerState = {
  status: "normal",  // normal, cautious, halted
  reason: null,
  haltedAt: null,
  trims: 0,
  lastCheck: null
};

// Regime-dependent thresholds
const REGIME_THRESHOLDS = {
  TREND_UP:   { dailyLossLimit: 30, breachProbHalt: 0.45, volGatePercent: 95 },
  TREND_DOWN: { dailyLossLimit: 25, breachProbHalt: 0.40, volGatePercent: 90 },
  RANGE:      { dailyLossLimit: 20, breachProbHalt: 0.35, volGatePercent: 90 },
  CHOP:       { dailyLossLimit: 12, breachProbHalt: 0.25, volGatePercent: 80 }
};

const DEFAULT_THRESHOLD = { dailyLossLimit: 20, breachProbHalt: 0.35, volGatePercent: 90 };

/**
 * Run full circuit breaker evaluation.
 * Call this on every scanner cycle to decide if trading should continue.
 *
 * @param {object} context
 * @param {string} context.regime - Current market regime
 * @param {number} context.breachProb4h - 4h breach probability from liquidation forecaster
 * @param {number} context.portfolioVol - Current portfolio volatility
 * @param {number} context.volPercentile - Current vol percentile (0-100)
 * @param {number} context.unrealizedPnl - Total unrealized P&L
 * @param {number} context.realizedPnlToday - Today's realized P&L
 * @returns {{ status, canTrade, canOpenNew, triggers, actions }}
 */
export function evaluateBreaker(context = {}) {
  const regime = context.regime || "RANGE";
  const thresholds = REGIME_THRESHOLDS[regime] || DEFAULT_THRESHOLD;
  const triggers = [];
  const actions = [];

  breakerState.lastCheck = new Date().toISOString();

  const realizedToday = context.realizedPnlToday ?? 0;
  const unrealized = context.unrealizedPnl ?? 0;
  const breachProb = context.breachProb4h ?? 0;
  const volPct = context.volPercentile ?? 50;

  // 1. Realized loss threshold (regime-adjusted)
  if (realizedToday < -thresholds.dailyLossLimit) {
    triggers.push({
      type: "realized_loss",
      severity: "critical",
      value: realizedToday,
      threshold: -thresholds.dailyLossLimit
    });
    actions.push({ action: "halt_trading", reason: "Daily loss limit exceeded" });
  }

  // 2. Breach probability gate
  if (breachProb > thresholds.breachProbHalt) {
    triggers.push({
      type: "breach_probability",
      severity: breachProb > 0.6 ? "critical" : "warning",
      value: Math.round(breachProb * 1000) / 1000,
      threshold: thresholds.breachProbHalt
    });

    if (breachProb > 0.6) {
      actions.push({ action: "halt_and_trim", reason: "High breach probability — halt and reduce positions" });
    } else {
      actions.push({ action: "block_new_entries", reason: "Elevated breach probability — no new positions" });
    }
  }

  // 3. Volatility gate
  if (volPct > thresholds.volGatePercent) {
    triggers.push({
      type: "volatility_gate",
      severity: "warning",
      value: volPct,
      threshold: thresholds.volGatePercent
    });
    actions.push({ action: "block_new_entries", reason: "Volatility exceeds regime threshold" });
  }

  // 4. Position heat (unrealized P&L drawdown)
  const heatThreshold = thresholds.dailyLossLimit * 0.6;
  if (unrealized < -heatThreshold) {
    triggers.push({
      type: "position_heat",
      severity: unrealized < -thresholds.dailyLossLimit ? "critical" : "warning",
      value: Math.round(unrealized * 100) / 100,
      threshold: -heatThreshold
    });
    actions.push({ action: "trim_positions", reason: "Unrealized losses exceeding heat threshold", trimPct: 0.30 });
  }

  // 5. Combined stress (realized + unrealized approaching limit)
  const combinedLoss = realizedToday + Math.min(0, unrealized);
  if (combinedLoss < -thresholds.dailyLossLimit * 0.8) {
    triggers.push({
      type: "combined_stress",
      severity: "warning",
      value: Math.round(combinedLoss * 100) / 100,
      threshold: Math.round(-thresholds.dailyLossLimit * 0.8 * 100) / 100
    });
    actions.push({ action: "reduce_size", reason: "Combined P&L approaching limit", sizeMult: 0.5 });
  }

  // Determine overall status
  const hasCritical = triggers.some(t => t.severity === "critical");
  const hasWarning = triggers.some(t => t.severity === "warning");
  const shouldHalt = actions.some(a => a.action === "halt_trading" || a.action === "halt_and_trim");
  const shouldBlock = actions.some(a => a.action === "block_new_entries");

  if (shouldHalt) {
    breakerState.status = "halted";
    breakerState.reason = actions.find(a => a.action.startsWith("halt"))?.reason;
    breakerState.haltedAt = new Date().toISOString();
  } else if (shouldBlock || hasWarning) {
    breakerState.status = "cautious";
    breakerState.reason = triggers[0]?.type || "elevated_risk";
  } else {
    breakerState.status = "normal";
    breakerState.reason = null;
  }

  return {
    status: breakerState.status,
    canTrade: breakerState.status !== "halted",
    canOpenNew: breakerState.status === "normal",
    regime,
    thresholds,
    triggers,
    actions,
    metrics: {
      realizedToday: Math.round(realizedToday * 100) / 100,
      unrealizedPnl: Math.round(unrealized * 100) / 100,
      combinedPnl: Math.round(combinedLoss * 100) / 100,
      breachProb4h: Math.round(breachProb * 1000) / 1000,
      volPercentile: volPct,
      dailyBudgetUsed: thresholds.dailyLossLimit > 0
        ? Math.round(Math.abs(realizedToday) / thresholds.dailyLossLimit * 1000) / 1000 : 0
    }
  };
}

/**
 * Get breaker status and history.
 *
 * @returns {{ current, history, stats }}
 */
export function getBreakerStatus() {
  const db = getDb();

  // Count recent halts from audit log
  const recentHalts = db.prepare(`
    SELECT COUNT(*) as cnt FROM audit_log
    WHERE action IN ('CIRCUIT_BREAK', 'HALT_TRADING')
    AND created_at > datetime('now', '-7 days')
  `).get();

  // Daily P&L for breach tracking
  const dailyPnl = db.prepare(`
    SELECT date(created_at) as day,
           SUM(realized_pnl) as pnl,
           COUNT(*) as trades
    FROM trade_executions
    WHERE created_at > datetime('now', '-7 days')
    AND status IN ('WIN', 'LOSS', 'CLOSED')
    GROUP BY date(created_at)
    ORDER BY day DESC
  `).all();

  const lossDays = dailyPnl.filter(d => d.pnl < 0).length;
  const avgDailyPnl = dailyPnl.length > 0
    ? dailyPnl.reduce((s, d) => s + d.pnl, 0) / dailyPnl.length : 0;

  return {
    current: {
      status: breakerState.status,
      reason: breakerState.reason,
      haltedAt: breakerState.haltedAt,
      lastCheck: breakerState.lastCheck,
      trimCount: breakerState.trims
    },
    stats: {
      haltsLast7Days: recentHalts?.cnt ?? 0,
      lossDaysLast7: lossDays,
      totalDays: dailyPnl.length,
      avgDailyPnl: Math.round(avgDailyPnl * 100) / 100
    },
    recentDays: dailyPnl.slice(0, 7).map(d => ({
      date: d.day,
      pnl: Math.round(d.pnl * 100) / 100,
      trades: d.trades,
      wouldHalt: d.pnl < -(DEFAULT_THRESHOLD.dailyLossLimit)
    }))
  };
}

/**
 * Reset breaker to normal state. Call after conditions improve.
 *
 * @param {string} reason
 * @returns {{ status, reason }}
 */
export function resetBreaker(reason = "manual_reset") {
  breakerState.status = "normal";
  breakerState.reason = null;
  breakerState.haltedAt = null;
  return { status: "normal", reason };
}
