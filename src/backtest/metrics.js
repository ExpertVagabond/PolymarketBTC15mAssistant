/**
 * Pure math functions for backtesting: accuracy, win rate, Sharpe, drawdown.
 */

/**
 * Accuracy: how often the dominant signal direction matched the outcome.
 * @param {Array<{predicted: string, actual: string}>} results — predicted/actual are "UP" or "DOWN"
 */
export function accuracy(results) {
  if (!results.length) return null;
  const correct = results.filter((r) => r.predicted === r.actual).length;
  return correct / results.length;
}

/**
 * Win rate grouped by a category field.
 * @param {Array<{category: string, predicted: string, actual: string}>} results
 * @returns {Record<string, {total: number, wins: number, winRate: number}>}
 */
export function winRateByCategory(results) {
  const groups = {};
  for (const r of results) {
    const key = r.category ?? "ALL";
    if (!groups[key]) groups[key] = { total: 0, wins: 0 };
    groups[key].total++;
    if (r.predicted === r.actual) groups[key].wins++;
  }
  for (const key of Object.keys(groups)) {
    groups[key].winRate = groups[key].total > 0 ? groups[key].wins / groups[key].total : 0;
  }
  return groups;
}

/**
 * Simulated P&L: bet $1 when signal says ENTER, win +edge, lose -1.
 * Uses a fixed bet size of $1 per trade.
 * @param {Array<{predicted: string, actual: string, edge: number}>} trades
 * @returns {{totalPnl: number, returns: number[], tradeCount: number}}
 */
export function simulatedPnl(trades) {
  const returns = [];
  let totalPnl = 0;

  for (const t of trades) {
    const won = t.predicted === t.actual;
    // simplified: win pays (1 + edge) - 1 = edge, loss pays -1
    const pnl = won ? (t.edge ?? 0.1) : -1;
    returns.push(pnl);
    totalPnl += pnl;
  }

  return { totalPnl, returns, tradeCount: trades.length };
}

/**
 * Annualized Sharpe ratio from an array of per-trade returns.
 * Assumes ~96 trades/day (15-min windows, 24h).
 */
export function sharpeRatio(returns, tradesPerDay = 96) {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  return (mean / std) * Math.sqrt(tradesPerDay * 365);
}

/**
 * Maximum drawdown from cumulative P&L series.
 */
export function maxDrawdown(returns) {
  if (!returns.length) return { maxDrawdown: 0, maxDrawdownPct: 0 };

  let peak = 0;
  let cumulative = 0;
  let worstDd = 0;

  for (const r of returns) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > worstDd) worstDd = dd;
  }

  return {
    maxDrawdown: worstDd,
    maxDrawdownPct: peak > 0 ? (worstDd / peak) * 100 : 0
  };
}

/**
 * Profit factor: gross wins / gross losses.
 */
export function profitFactor(returns) {
  const wins = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(returns.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  if (losses === 0) return wins > 0 ? Infinity : null;
  return wins / losses;
}

/**
 * Expectancy: average profit per trade.
 */
export function expectancy(returns) {
  if (!returns.length) return null;
  return returns.reduce((a, b) => a + b, 0) / returns.length;
}
