/**
 * Adaptive risk limits with real-time stress-driven guardrails.
 *
 * Dynamically adjusts position limits based on:
 * - Current regime and volatility
 * - Recent drawdown severity
 * - Model confidence trends
 * - Live stress test results
 *
 * Replaces static risk budgets with responsive limits:
 * - Adaptive Kelly fraction (regime-scaled)
 * - Per-market position caps
 * - Portfolio-level drawdown triggers
 * - Deleveraging recommendations
 */

import { getDb } from "../subscribers/db.js";

// Default limits (overridden dynamically)
const BASE_LIMITS = {
  maxPositionPct: 0.15,     // 15% of portfolio per market
  maxDailyLoss: 50,         // $50 daily loss limit
  maxDrawdownPct: 0.20,     // 20% max drawdown before halt
  maxOpenPositions: 10,
  kellyFraction: 0.25       // Quarter-Kelly default
};

// Regime multipliers for risk limits
const REGIME_MULTIPLIERS = {
  TREND_UP:   { kelly: 1.2, positionCap: 1.1, lossLimit: 1.3 },
  TREND_DOWN: { kelly: 0.8, positionCap: 0.9, lossLimit: 0.8 },
  RANGE:      { kelly: 1.0, positionCap: 1.0, lossLimit: 1.0 },
  CHOP:       { kelly: 0.5, positionCap: 0.6, lossLimit: 0.5 },
  unknown:    { kelly: 0.7, positionCap: 0.8, lossLimit: 0.7 }
};

/**
 * Compute adaptive Kelly fraction based on context.
 *
 * @param {object} context
 * @param {string} context.regime
 * @param {number} context.recentDrawdown - Max drawdown last 7 days
 * @param {number} context.volatilityPctile - Current vol percentile (0-100)
 * @param {number} context.modelAccuracy - Recent prediction accuracy (0-1)
 * @returns {{ baseFraction, adaptiveMultiplier, recommendedFraction, rationale }}
 */
export function computeAdaptiveKelly(context = {}) {
  const regime = context.regime || "RANGE";
  const drawdown = Math.abs(context.recentDrawdown || 0);
  const volPctile = context.volatilityPctile || 50;
  const accuracy = context.modelAccuracy || 0.5;

  const regimeMult = REGIME_MULTIPLIERS[regime] || REGIME_MULTIPLIERS.unknown;
  let multiplier = regimeMult.kelly;
  const rationale = [];

  // Drawdown scaling: reduce proportionally to drawdown severity
  if (drawdown > 30) {
    multiplier *= 0.3;
    rationale.push(`Severe drawdown ($${drawdown}) → 70% reduction`);
  } else if (drawdown > 15) {
    multiplier *= 0.6;
    rationale.push(`Moderate drawdown ($${drawdown}) → 40% reduction`);
  } else if (drawdown > 5) {
    multiplier *= 0.85;
    rationale.push(`Minor drawdown ($${drawdown}) → 15% reduction`);
  }

  // Volatility scaling: reduce in extreme vol
  if (volPctile > 90) {
    multiplier *= 0.5;
    rationale.push(`Extreme volatility (p${volPctile}) → 50% reduction`);
  } else if (volPctile > 75) {
    multiplier *= 0.75;
    rationale.push(`High volatility (p${volPctile}) → 25% reduction`);
  }

  // Accuracy boost/penalty
  if (accuracy > 0.65) {
    multiplier *= 1.15;
    rationale.push(`High accuracy (${(accuracy * 100).toFixed(0)}%) → 15% boost`);
  } else if (accuracy < 0.45) {
    multiplier *= 0.6;
    rationale.push(`Low accuracy (${(accuracy * 100).toFixed(0)}%) → 40% reduction`);
  }

  // Regime label
  rationale.unshift(`Regime: ${regime} (base mult: ${regimeMult.kelly}x)`);

  const recommended = round4(BASE_LIMITS.kellyFraction * Math.max(0.05, Math.min(2.0, multiplier)));

  return {
    baseFraction: BASE_LIMITS.kellyFraction,
    adaptiveMultiplier: round3(multiplier),
    recommendedFraction: recommended,
    effectiveKelly: round4(recommended),
    rationale
  };
}

/**
 * Generate adaptive position limits per market.
 *
 * @param {number} days - Lookback for performance data
 * @returns {{ limits, globalLimits, regime }}
 */
export function getAdaptivePositionLimits(days = 7) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  // Get recent performance by market
  const rows = db.prepare(`
    SELECT market_id, category, regime,
           SUM(realized_pnl) as total_pnl,
           COUNT(*) as trades,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
           MAX(ABS(realized_pnl)) as max_single_trade,
           AVG(confidence) as avg_confidence
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY market_id
  `).all(daysOffset);

  if (rows.length === 0) {
    return { limits: [], globalLimits: BASE_LIMITS, regime: "unknown", message: "no_data" };
  }

  // Determine current regime from most recent trades
  const regimeCounts = {};
  for (const r of rows) {
    regimeCounts[r.regime || "unknown"] = (regimeCounts[r.regime || "unknown"] || 0) + r.trades;
  }
  const currentRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "RANGE";
  const regimeMult = REGIME_MULTIPLIERS[currentRegime] || REGIME_MULTIPLIERS.unknown;

  // Per-market limits
  const limits = rows.map(r => {
    const winRate = r.trades > 0 ? r.wins / r.trades : 0.5;
    const avgPnl = r.trades > 0 ? r.total_pnl / r.trades : 0;

    // Performance-based cap adjustment
    let capMult = 1.0;
    if (winRate > 0.65 && avgPnl > 0) capMult = 1.3;
    else if (winRate < 0.4 || avgPnl < 0) capMult = 0.5;
    else if (winRate < 0.5) capMult = 0.7;

    const maxPct = round3(BASE_LIMITS.maxPositionPct * regimeMult.positionCap * capMult);
    const maxLoss = round2(BASE_LIMITS.maxDailyLoss * regimeMult.lossLimit * capMult / Math.max(1, rows.length));

    return {
      marketId: r.market_id?.slice(0, 20) || "unknown",
      category: r.category || "unknown",
      maxPositionPct: Math.min(0.30, maxPct),
      maxDailyLoss: maxLoss,
      winRate: round3(winRate),
      avgPnl: round2(avgPnl),
      trades: r.trades,
      capMultiplier: round3(capMult),
      reason: capMult > 1 ? "outperforming" : capMult < 0.7 ? "underperforming" : "standard"
    };
  });

  limits.sort((a, b) => b.maxPositionPct - a.maxPositionPct);

  // Global limits scaled by regime
  const globalLimits = {
    maxDailyLoss: round2(BASE_LIMITS.maxDailyLoss * regimeMult.lossLimit),
    maxDrawdownPct: round3(BASE_LIMITS.maxDrawdownPct * (currentRegime === "CHOP" ? 0.6 : 1.0)),
    maxOpenPositions: Math.round(BASE_LIMITS.maxOpenPositions * regimeMult.positionCap),
    kellyFraction: round4(BASE_LIMITS.kellyFraction * regimeMult.kelly)
  };

  return {
    limits: limits.slice(0, 20),
    globalLimits,
    regime: currentRegime,
    regimeMultiplier: regimeMult,
    marketsTracked: rows.length
  };
}

/**
 * Run live stress test across portfolio.
 *
 * @param {number} days - Lookback
 * @param {object} opts
 * @param {number} opts.shockPct - Shock magnitude (default 0.10 = 10%)
 * @returns {{ scenarios, portfolioRisk, alerts }}
 */
export function runLiveStressTest(days = 14, opts = {}) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;
  const shockPct = opts.shockPct || 0.10;

  // Get open-ish positions (recent trades)
  const rows = db.prepare(`
    SELECT market_id, category, regime, side,
           SUM(realized_pnl) as total_pnl,
           COUNT(*) as trades,
           AVG(realized_pnl) as avg_pnl,
           AVG(confidence) as avg_conf
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND realized_pnl IS NOT NULL
    GROUP BY market_id
  `).all(daysOffset);

  if (rows.length === 0) {
    return { scenarios: [], portfolioRisk: 0, alerts: [] };
  }

  // Scenario: uniform shock
  const uniformShock = rows.map(r => ({
    market: r.market_id?.slice(0, 20),
    expectedLoss: round2(Math.abs(r.avg_pnl) * r.trades * shockPct),
    trades: r.trades,
    side: r.side || "YES"
  }));
  const uniformTotal = uniformShock.reduce((s, r) => s + r.expectedLoss, 0);

  // Scenario: category-concentrated shock
  const byCat = {};
  for (const r of rows) {
    const cat = r.category || "unknown";
    if (!byCat[cat]) byCat[cat] = { exposure: 0, markets: 0 };
    byCat[cat].exposure += Math.abs(r.total_pnl);
    byCat[cat].markets++;
  }
  const worstCategory = Object.entries(byCat).sort((a, b) => b[1].exposure - a[1].exposure)[0];

  // Scenario: regime flip (TREND → CHOP)
  const trendTrades = rows.filter(r => r.regime?.includes("TREND"));
  const regimeFlipLoss = trendTrades.reduce((s, r) => s + Math.abs(r.avg_pnl) * r.trades * 0.3, 0);

  const scenarios = [
    {
      name: "uniform_shock",
      description: `${(shockPct * 100).toFixed(0)}% adverse move across all markets`,
      expectedLoss: round2(uniformTotal),
      affectedMarkets: rows.length,
      probability: "low"
    },
    {
      name: "category_concentration",
      description: `Worst category (${worstCategory?.[0] || "unknown"}) collapses`,
      expectedLoss: round2((worstCategory?.[1]?.exposure || 0) * shockPct * 2),
      affectedMarkets: worstCategory?.[1]?.markets || 0,
      probability: "medium"
    },
    {
      name: "regime_flip",
      description: "Trend regime flips to chop — trend-following positions impaired",
      expectedLoss: round2(regimeFlipLoss),
      affectedMarkets: trendTrades.length,
      probability: "medium"
    }
  ];

  // Alerts
  const alerts = [];
  const globalLimit = BASE_LIMITS.maxDailyLoss;
  for (const s of scenarios) {
    if (s.expectedLoss > globalLimit) {
      alerts.push({
        type: "stress_breach",
        scenario: s.name,
        severity: s.expectedLoss > globalLimit * 2 ? "critical" : "warning",
        expectedLoss: s.expectedLoss,
        limit: globalLimit,
        action: "Consider reducing exposure"
      });
    }
  }

  // Portfolio risk score (0-100)
  const maxLoss = Math.max(...scenarios.map(s => s.expectedLoss));
  const portfolioRisk = Math.min(100, Math.round(maxLoss / globalLimit * 50));

  return {
    scenarios,
    portfolioRisk,
    riskLevel: portfolioRisk > 70 ? "critical" : portfolioRisk > 40 ? "elevated" : "normal",
    alerts,
    shockMagnitude: shockPct,
    globalDailyLimit: globalLimit
  };
}

/**
 * Get deleveraging recommendations.
 *
 * @param {number} maxAcceptableLoss - Max acceptable loss in dollars
 * @param {number} days - Lookback
 * @returns {{ actions, totalRiskReduction, currentExposure }}
 */
export function getDeleveragingPlan(maxAcceptableLoss = 50, days = 7) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT market_id, category, side,
           SUM(realized_pnl) as total_pnl,
           COUNT(*) as trades,
           AVG(confidence) as avg_conf,
           AVG(quality_score) as avg_quality
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY market_id
    ORDER BY SUM(realized_pnl) ASC
  `).all(daysOffset);

  if (rows.length === 0) {
    return { actions: [], totalRiskReduction: 0, currentExposure: 0 };
  }

  const totalExposure = rows.reduce((s, r) => s + Math.abs(r.total_pnl), 0);
  const actions = [];
  let reducedRisk = 0;

  // Prioritize closing worst performers
  for (const r of rows) {
    if (reducedRisk >= totalExposure - maxAcceptableLoss) break;

    const riskContrib = Math.abs(r.total_pnl);
    const winRate = r.trades > 0 ? r.total_pnl / r.trades : 0;
    const shouldClose = winRate < 0 || (r.avg_conf || 0) < 0.5;

    if (shouldClose) {
      actions.push({
        marketId: r.market_id?.slice(0, 20),
        action: "close",
        priority: winRate < -1 ? "immediate" : "soon",
        rationale: winRate < 0
          ? `Losing market (avg P&L: ${round2(winRate)})`
          : `Low confidence (${round2(r.avg_conf || 0)})`,
        riskReduction: round2(riskContrib)
      });
      reducedRisk += riskContrib;
    }
  }

  return {
    actions: actions.slice(0, 10),
    totalRiskReduction: round2(reducedRisk),
    currentExposure: round2(totalExposure),
    targetExposure: round2(maxAcceptableLoss),
    sufficientReduction: reducedRisk >= totalExposure - maxAcceptableLoss
  };
}

/**
 * Get full adaptive risk status.
 *
 * @returns {{ kelly, limits, stress, deleveraging }}
 */
export function getAdaptiveRiskStatus() {
  const limits = getAdaptivePositionLimits();
  const stress = runLiveStressTest();
  const kelly = computeAdaptiveKelly({
    regime: limits.regime,
    recentDrawdown: stress.scenarios[0]?.expectedLoss || 0,
    volatilityPctile: 50,
    modelAccuracy: 0.55
  });

  return {
    kelly,
    limits: {
      global: limits.globalLimits,
      topMarkets: limits.limits.slice(0, 5),
      regime: limits.regime
    },
    stress: {
      portfolioRisk: stress.portfolioRisk,
      riskLevel: stress.riskLevel,
      worstScenario: stress.scenarios[0] || null,
      alertCount: stress.alerts.length
    }
  };
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
function round4(v) { return Math.round((v ?? 0) * 10000) / 10000; }
