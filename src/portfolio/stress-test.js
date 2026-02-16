/**
 * Portfolio stress testing engine.
 *
 * Runs scenario analysis on the current portfolio to estimate
 * potential losses under adverse conditions:
 *
 * Scenarios:
 * - BTC crash (-10%, -20%)
 * - Volatility spike (2x, 3x)
 * - Category-specific shock (politics event, crypto flash crash)
 * - Correlated liquidation (all positions move against simultaneously)
 *
 * Also computes tail risk metrics:
 * - 95th/99th percentile daily loss from historical data
 * - Maximum drawdown attribution by signal source
 */

import { getDb } from "../subscribers/db.js";

// Predefined stress scenarios
const SCENARIOS = [
  {
    name: "BTC -10%",
    desc: "Bitcoin drops 10% — crypto markets hit hardest, politics/sports unaffected",
    shocks: { crypto: -0.15, politics: -0.02, sports: 0, entertainment: -0.03, weather: 0, other: -0.05 }
  },
  {
    name: "BTC -20%",
    desc: "Bitcoin crash 20% — crypto markets severe, contagion to other markets",
    shocks: { crypto: -0.30, politics: -0.05, sports: -0.02, entertainment: -0.05, weather: 0, other: -0.10 }
  },
  {
    name: "Volatility 2x",
    desc: "Market volatility doubles — all positions lose from wider spreads and whipsaws",
    shocks: { crypto: -0.08, politics: -0.05, sports: -0.03, entertainment: -0.04, weather: -0.02, other: -0.06 }
  },
  {
    name: "Political shock",
    desc: "Major political event — politics markets whipsaw, others mildly affected",
    shocks: { crypto: -0.02, politics: -0.20, sports: 0, entertainment: -0.03, weather: 0, other: -0.05 }
  },
  {
    name: "Correlated sell-off",
    desc: "All markets move against positions simultaneously — worst case",
    shocks: { crypto: -0.15, politics: -0.12, sports: -0.08, entertainment: -0.10, weather: -0.05, other: -0.12 }
  }
];

/**
 * Run stress test on current open positions.
 * @returns {{ scenarios: object[], portfolio: object, worstCase: object }}
 */
export function runStressTest() {
  const db = getDb();

  // Get open positions from trade_executions
  const positions = db.prepare(`
    SELECT id, market_id, question, category, side, bet_size_usd, entry_price,
           confidence, edge_at_entry, quality_score
    FROM trade_executions
    WHERE status = 'open'
  `).all();

  if (positions.length === 0) {
    return { scenarios: [], portfolio: { positions: 0, totalExposure: 0 }, worstCase: null, message: "No open positions" };
  }

  const totalExposure = positions.reduce((s, p) => s + (p.bet_size_usd || 0), 0);

  const results = [];

  for (const scenario of SCENARIOS) {
    let scenarioLoss = 0;
    const positionImpacts = [];

    for (const pos of positions) {
      const cat = (pos.category || "other").toLowerCase();
      const shock = scenario.shocks[cat] ?? scenario.shocks.other ?? -0.05;

      // Loss = position size * shock factor * side direction
      // YES positions lose when market drops, NO positions gain
      const directionMultiplier = pos.side === "UP" ? 1 : -1;
      const posLoss = (pos.bet_size_usd || 0) * shock * directionMultiplier;

      scenarioLoss += posLoss;
      positionImpacts.push({
        id: pos.id,
        question: (pos.question || "").slice(0, 50),
        category: cat,
        side: pos.side,
        exposure: pos.bet_size_usd || 0,
        impact: Math.round(posLoss * 100) / 100,
        shockPct: Math.round(shock * 100)
      });
    }

    results.push({
      name: scenario.name,
      desc: scenario.desc,
      totalImpact: Math.round(scenarioLoss * 100) / 100,
      impactPct: totalExposure > 0 ? Math.round((scenarioLoss / totalExposure) * 10000) / 100 : 0,
      positionImpacts: positionImpacts.sort((a, b) => a.impact - b.impact).slice(0, 5)
    });
  }

  // Find worst case
  const worstCase = results.reduce((w, r) => r.totalImpact < w.totalImpact ? r : w, results[0]);

  return {
    scenarios: results,
    portfolio: {
      positions: positions.length,
      totalExposure: Math.round(totalExposure * 100) / 100,
      categories: [...new Set(positions.map(p => (p.category || "other").toLowerCase()))]
    },
    worstCase: { name: worstCase.name, loss: worstCase.totalImpact, lossPct: worstCase.impactPct }
  };
}

/**
 * Get tail risk metrics from historical trade data.
 * @param {number} days - lookback window
 * @returns {{ p95Loss, p99Loss, maxDailyLoss, avgDailyPnl, volatility, sharpe, dailyReturns }}
 */
export function getTailRisk(days = 90) {
  const db = getDb();

  const dailyPnl = db.prepare(`
    SELECT date(closed_at) as day, SUM(pnl_usd) as daily_pnl, COUNT(*) as trades
    FROM trade_executions
    WHERE status = 'closed' AND pnl_usd IS NOT NULL
      AND closed_at > datetime('now', ?)
    GROUP BY date(closed_at)
    ORDER BY daily_pnl ASC
  `).all(`-${days} days`);

  if (dailyPnl.length < 5) {
    return { insufficient: true, days, dataPoints: dailyPnl.length };
  }

  const pnls = dailyPnl.map(d => d.daily_pnl);
  const n = pnls.length;

  // Percentiles (already sorted ascending)
  const p95Idx = Math.floor(n * 0.05);
  const p99Idx = Math.floor(n * 0.01);
  const p95Loss = Math.round(pnls[p95Idx] * 100) / 100;
  const p99Loss = Math.round(pnls[Math.max(0, p99Idx)] * 100) / 100;
  const maxDailyLoss = Math.round(pnls[0] * 100) / 100;

  // Average and volatility
  const avg = pnls.reduce((s, v) => s + v, 0) / n;
  const variance = pnls.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / n;
  const volatility = Math.sqrt(variance);
  const sharpe = volatility > 0 ? avg / volatility : 0;

  return {
    p95Loss,
    p99Loss,
    maxDailyLoss,
    avgDailyPnl: Math.round(avg * 100) / 100,
    volatility: Math.round(volatility * 100) / 100,
    dailySharpe: Math.round(sharpe * 1000) / 1000,
    tradingDays: n,
    days,
    dailyReturns: dailyPnl.slice(0, 30).map(d => ({
      day: d.day,
      pnl: Math.round(d.daily_pnl * 100) / 100,
      trades: d.trades
    }))
  };
}

/**
 * Get available stress scenarios for display.
 */
export function getStressScenarios() {
  return SCENARIOS.map(s => ({ name: s.name, desc: s.desc, categories: Object.keys(s.shocks) }));
}
