/**
 * Monte Carlo backtesting framework.
 *
 * Randomized scenario testing beyond deterministic replay:
 * - Bootstrap return sampling: resample historical trade returns
 * - Confidence intervals on Sharpe, drawdown, and win rate
 * - Parameter sensitivity: sweep across confidence/edge thresholds
 * - Path-dependent stress: correlated drawdown sequences
 *
 * Uses 1000 simulation paths by default for statistical significance.
 */

import { getDb } from "../subscribers/db.js";

const DEFAULT_PATHS = 1000;

/**
 * Run Monte Carlo simulation on historical trade returns.
 * Bootstrap-resamples actual P&L to estimate strategy statistics.
 *
 * @param {number} days - Historical lookback
 * @param {object} opts
 * @param {number} opts.paths - Number of simulation paths
 * @param {number} opts.tradesPerPath - Trades per simulated path
 * @returns {{ percentiles, confidenceIntervals, paths }}
 */
export function runMonteCarloSimulation(days = 30, opts = {}) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;
  const numPaths = Math.min(opts.paths || DEFAULT_PATHS, 5000);

  const rows = db.prepare(`
    SELECT realized_pnl, status, confidence, regime, category
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS', 'CLOSED')
    AND realized_pnl IS NOT NULL
    ORDER BY created_at DESC
  `).all(daysOffset);

  if (rows.length < 10) {
    return { percentiles: null, confidenceIntervals: null, message: "insufficient_data" };
  }

  const returns = rows.map(r => r.realized_pnl);
  const tradesPerPath = opts.tradesPerPath || returns.length;

  // Run bootstrap simulations
  const pathResults = [];

  for (let p = 0; p < numPaths; p++) {
    let cumPnl = 0;
    let maxPnl = 0;
    let maxDrawdown = 0;
    let wins = 0;

    for (let t = 0; t < tradesPerPath; t++) {
      // Random sample with replacement
      const idx = Math.floor(Math.random() * returns.length);
      cumPnl += returns[idx];

      if (cumPnl > maxPnl) maxPnl = cumPnl;
      const drawdown = maxPnl - cumPnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      if (returns[idx] > 0) wins++;
    }

    const winRate = wins / tradesPerPath;
    const avgReturn = cumPnl / tradesPerPath;
    const stdReturn = Math.sqrt(
      returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length
    );
    const sharpe = stdReturn > 0 ? avgReturn / stdReturn * Math.sqrt(252) : 0;

    pathResults.push({
      totalPnl: cumPnl,
      maxDrawdown,
      winRate,
      sharpe,
      avgReturn
    });
  }

  // Sort for percentile extraction
  const sortedPnl = pathResults.map(r => r.totalPnl).sort((a, b) => a - b);
  const sortedDD = pathResults.map(r => r.maxDrawdown).sort((a, b) => a - b);
  const sortedSharpe = pathResults.map(r => r.sharpe).sort((a, b) => a - b);
  const sortedWR = pathResults.map(r => r.winRate).sort((a, b) => a - b);

  const pct = (arr, p) => arr[Math.floor(arr.length * p)];

  return {
    simulation: {
      paths: numPaths,
      tradesPerPath,
      sourceTrades: returns.length,
      lookbackDays: days
    },
    percentiles: {
      totalPnl: {
        p5: round2(pct(sortedPnl, 0.05)),
        p25: round2(pct(sortedPnl, 0.25)),
        p50: round2(pct(sortedPnl, 0.50)),
        p75: round2(pct(sortedPnl, 0.75)),
        p95: round2(pct(sortedPnl, 0.95))
      },
      maxDrawdown: {
        p5: round2(pct(sortedDD, 0.05)),
        p50: round2(pct(sortedDD, 0.50)),
        p95: round2(pct(sortedDD, 0.95))
      },
      sharpe: {
        p5: round2(pct(sortedSharpe, 0.05)),
        p50: round2(pct(sortedSharpe, 0.50)),
        p95: round2(pct(sortedSharpe, 0.95))
      },
      winRate: {
        p5: round3(pct(sortedWR, 0.05)),
        p50: round3(pct(sortedWR, 0.50)),
        p95: round3(pct(sortedWR, 0.95))
      }
    },
    confidenceIntervals: {
      pnl_90: { lower: round2(pct(sortedPnl, 0.05)), upper: round2(pct(sortedPnl, 0.95)) },
      drawdown_90: { lower: round2(pct(sortedDD, 0.05)), upper: round2(pct(sortedDD, 0.95)) },
      sharpe_90: { lower: round2(pct(sortedSharpe, 0.05)), upper: round2(pct(sortedSharpe, 0.95)) },
      winRate_90: { lower: round3(pct(sortedWR, 0.05)), upper: round3(pct(sortedWR, 0.95)) }
    },
    riskMetrics: {
      probOfLoss: round3(sortedPnl.filter(v => v < 0).length / numPaths),
      probOfDrawdown50: round3(sortedDD.filter(v => v > 50).length / numPaths),
      expectedWorstCase: round2(pct(sortedPnl, 0.01)),
      expectedBestCase: round2(pct(sortedPnl, 0.99))
    }
  };
}

/**
 * Parameter sensitivity analysis.
 * Sweeps across confidence and edge thresholds to find optimal parameters.
 *
 * @param {number} days - Lookback
 * @returns {{ grid: object[], optimal: object }}
 */
export function parameterSensitivity(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT realized_pnl, confidence, edge_at_entry, quality_score, status
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 20) {
    return { grid: [], optimal: null, message: "insufficient_data" };
  }

  // Sweep: confidence × edge threshold
  const confLevels = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  const edgeLevels = [0, 0.01, 0.02, 0.03, 0.05, 0.08];

  const grid = [];

  for (const minConf of confLevels) {
    for (const minEdge of edgeLevels) {
      const filtered = rows.filter(r =>
        (r.confidence ?? 0) >= minConf &&
        (r.edge_at_entry ?? 0) >= minEdge
      );

      if (filtered.length < 5) continue;

      const wins = filtered.filter(r => r.status === "WIN").length;
      const totalPnl = filtered.reduce((s, r) => s + r.realized_pnl, 0);
      const avgPnl = totalPnl / filtered.length;

      grid.push({
        minConfidence: minConf,
        minEdge: minEdge,
        trades: filtered.length,
        passRate: round3(filtered.length / rows.length),
        winRate: round3(wins / filtered.length),
        avgPnl: round2(avgPnl),
        totalPnl: round2(totalPnl),
        sharpeProxy: round2(avgPnl / (stddev(filtered.map(r => r.realized_pnl)) || 1))
      });
    }
  }

  // Find optimal (highest Sharpe with at least 10% pass rate)
  const viable = grid.filter(g => g.passRate >= 0.10 && g.trades >= 10);
  viable.sort((a, b) => b.sharpeProxy - a.sharpeProxy);

  return {
    grid,
    optimal: viable[0] || null,
    totalTrades: rows.length,
    gridPoints: grid.length
  };
}

/**
 * Regime-conditional Monte Carlo.
 * Runs separate simulations per regime to compare strategy robustness.
 *
 * @param {number} days
 * @returns {{ byRegime: object[] }}
 */
export function regimeMonteCarlo(days = 30) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT realized_pnl, regime, status
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
  `).all(daysOffset);

  const byRegime = {};
  for (const r of rows) {
    const key = r.regime || "unknown";
    if (!byRegime[key]) byRegime[key] = [];
    byRegime[key].push(r.realized_pnl);
  }

  const results = [];
  for (const [regime, returns] of Object.entries(byRegime)) {
    if (returns.length < 5) continue;

    // Run 500 paths per regime
    const paths = 500;
    const pathPnls = [];

    for (let p = 0; p < paths; p++) {
      let cumPnl = 0;
      for (let t = 0; t < returns.length; t++) {
        cumPnl += returns[Math.floor(Math.random() * returns.length)];
      }
      pathPnls.push(cumPnl);
    }

    pathPnls.sort((a, b) => a - b);

    results.push({
      regime,
      sourceTrades: returns.length,
      median: round2(pathPnls[Math.floor(paths * 0.5)]),
      p5: round2(pathPnls[Math.floor(paths * 0.05)]),
      p95: round2(pathPnls[Math.floor(paths * 0.95)]),
      probOfLoss: round3(pathPnls.filter(v => v < 0).length / paths),
      avgReturn: round2(returns.reduce((s, v) => s + v, 0) / returns.length),
      winRate: round3(returns.filter(v => v > 0).length / returns.length)
    });
  }

  results.sort((a, b) => b.median - a.median);

  return { byRegime: results };
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
function stddev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}
