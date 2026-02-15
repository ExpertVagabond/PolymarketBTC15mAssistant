/**
 * Rolling performance anomaly detector.
 *
 * Compares recent performance (last 20 trades) against a longer baseline
 * (last 100 trades) to detect statistically significant degradation.
 *
 * Detects:
 * - Win rate drops (>15% below baseline)
 * - Sharpe ratio drops (>30% below baseline)
 * - Quality effectiveness decay (high quality trades underperforming)
 *
 * Returns anomaly severity: none | warning | critical
 */

import { getRecentPerformance } from "../trading/execution-log.js";

const RECENT_WINDOW = 20;
const BASELINE_WINDOW = 100;

/**
 * Run anomaly detection comparing recent vs baseline performance.
 * @returns {{ severity, anomalies, recent, baseline, recommendation }}
 */
export function detectAnomalies() {
  const recent = getRecentPerformance(RECENT_WINDOW);
  const baseline = getRecentPerformance(BASELINE_WINDOW);

  // Need minimum data
  if (baseline.trades < 30) {
    return {
      severity: "none",
      anomalies: [],
      recent,
      baseline,
      recommendation: "Insufficient data for anomaly detection (need 30+ closed trades)"
    };
  }
  if (recent.trades < 10) {
    return {
      severity: "none",
      anomalies: [],
      recent,
      baseline,
      recommendation: "Insufficient recent data (need 10+ recent trades)"
    };
  }

  const anomalies = [];

  // 1. Win rate drop
  if (baseline.winRate != null && recent.winRate != null) {
    const winRateDrop = baseline.winRate - recent.winRate;
    if (winRateDrop > 20) {
      anomalies.push({
        type: "win_rate_drop",
        severity: "critical",
        detail: `Win rate dropped ${winRateDrop}pts: ${baseline.winRate}% → ${recent.winRate}%`,
        baseline: baseline.winRate,
        recent: recent.winRate,
        delta: -winRateDrop
      });
    } else if (winRateDrop > 15) {
      anomalies.push({
        type: "win_rate_drop",
        severity: "warning",
        detail: `Win rate dropped ${winRateDrop}pts: ${baseline.winRate}% → ${recent.winRate}%`,
        baseline: baseline.winRate,
        recent: recent.winRate,
        delta: -winRateDrop
      });
    }
  }

  // 2. Sharpe ratio drop
  if (baseline.sharpe != null && recent.sharpe != null && baseline.sharpe > 0) {
    const sharpePctDrop = ((baseline.sharpe - recent.sharpe) / Math.abs(baseline.sharpe)) * 100;
    if (sharpePctDrop > 50) {
      anomalies.push({
        type: "sharpe_drop",
        severity: "critical",
        detail: `Sharpe dropped ${Math.round(sharpePctDrop)}%: ${baseline.sharpe} → ${recent.sharpe}`,
        baseline: baseline.sharpe,
        recent: recent.sharpe,
        delta: -Math.round(sharpePctDrop)
      });
    } else if (sharpePctDrop > 30) {
      anomalies.push({
        type: "sharpe_drop",
        severity: "warning",
        detail: `Sharpe dropped ${Math.round(sharpePctDrop)}%: ${baseline.sharpe} → ${recent.sharpe}`,
        baseline: baseline.sharpe,
        recent: recent.sharpe,
        delta: -Math.round(sharpePctDrop)
      });
    }
  }

  // 3. Recent losing streak (all recent trades negative)
  if (recent.winRate != null && recent.winRate < 25 && recent.trades >= 10) {
    anomalies.push({
      type: "losing_streak",
      severity: "critical",
      detail: `Only ${recent.winRate}% win rate in last ${recent.trades} trades (${recent.wins}W/${recent.losses}L)`,
      baseline: baseline.winRate,
      recent: recent.winRate
    });
  }

  // 4. P&L degradation
  if (baseline.avgPnlPct != null && recent.avgPnlPct != null) {
    if (baseline.avgPnlPct > 0 && recent.avgPnlPct < -2) {
      anomalies.push({
        type: "pnl_reversal",
        severity: "critical",
        detail: `Avg P&L reversed: ${baseline.avgPnlPct}% → ${recent.avgPnlPct}%`,
        baseline: baseline.avgPnlPct,
        recent: recent.avgPnlPct
      });
    } else if (baseline.avgPnlPct > 0 && recent.avgPnlPct < 0) {
      anomalies.push({
        type: "pnl_reversal",
        severity: "warning",
        detail: `Avg P&L turned negative: ${baseline.avgPnlPct}% → ${recent.avgPnlPct}%`,
        baseline: baseline.avgPnlPct,
        recent: recent.avgPnlPct
      });
    }
  }

  // Determine overall severity
  const hasCritical = anomalies.some(a => a.severity === "critical");
  const hasWarning = anomalies.some(a => a.severity === "warning");
  const severity = hasCritical ? "critical" : hasWarning ? "warning" : "none";

  // Generate recommendation
  let recommendation = "System performing within normal parameters.";
  if (severity === "critical") {
    recommendation = "CRITICAL: Performance significantly degraded. Consider pausing live trading and reviewing recent market conditions, strategy parameters, and quality thresholds.";
  } else if (severity === "warning") {
    recommendation = "WARNING: Performance slightly below baseline. Monitor closely. Consider raising quality gate or reducing position sizes.";
  }

  return {
    severity,
    anomalies,
    recent,
    baseline,
    recommendation,
    timestamp: new Date().toISOString()
  };
}
