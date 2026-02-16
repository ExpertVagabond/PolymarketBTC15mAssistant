/**
 * Cross-exchange basis tracker.
 *
 * Compares Polymarket implied prices vs external reference prices:
 * - Basis computation (premium/discount vs reference)
 * - Convergence tracking over time
 * - Divergence alerts when basis exceeds thresholds
 * - Category-level basis aggregation
 * - Basis mean-reversion signal generation
 *
 * Unifies data from Binance/Polymarket feeds for cross-exchange analytics.
 */

import { getDb } from "../subscribers/db.js";

// In-memory basis history
const basisHistory = {};  // marketId → [{ basis, timestamp }]
const HISTORY_SIZE = 200;

// Reference price store
const referenceStore = {};  // symbol → { price, source, timestamp }

/**
 * Record a reference price from external source.
 *
 * @param {string} symbol - e.g., "BTC", "ETH"
 * @param {number} price
 * @param {string} source - e.g., "binance", "chainlink"
 */
export function recordReferencePrice(symbol, price, source = "binance") {
  referenceStore[symbol] = { price, source, timestamp: Date.now() };
}

/**
 * Record a basis observation for a market.
 *
 * @param {string} marketId
 * @param {number} polyPrice - Polymarket YES price
 * @param {number} refPrice - Reference implied price (0-1 normalized)
 */
export function recordBasis(marketId, polyPrice, refPrice) {
  const basis = polyPrice - refPrice;
  if (!basisHistory[marketId]) basisHistory[marketId] = [];
  basisHistory[marketId].push({ basis, polyPrice, refPrice, timestamp: Date.now() });
  if (basisHistory[marketId].length > HISTORY_SIZE) {
    basisHistory[marketId] = basisHistory[marketId].slice(-HISTORY_SIZE);
  }
}

/**
 * Get basis tracking for all markets.
 * Uses historical trade data to infer basis from confidence vs outcome.
 *
 * @param {number} days
 * @returns {{ markets, avgBasis, basisDistribution, divergences }}
 */
export function getBasisOverview(days = 7) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  // Use model confidence vs realized outcome as "basis" proxy
  const rows = db.prepare(`
    SELECT market_id, category, confidence, edge_at_entry,
           realized_pnl, status, regime
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    AND confidence IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 10) {
    return { markets: [], avgBasis: 0, message: "insufficient_data" };
  }

  // Per-market basis: confidence vs actual win rate
  const byMarket = {};
  for (const r of rows) {
    const mid = r.market_id || "unknown";
    if (!byMarket[mid]) byMarket[mid] = { confSum: 0, wins: 0, count: 0, category: r.category, edges: [] };
    byMarket[mid].confSum += r.confidence;
    if (r.status === "WIN") byMarket[mid].wins++;
    byMarket[mid].count++;
    byMarket[mid].edges.push(r.edge_at_entry || 0);
  }

  const markets = Object.entries(byMarket)
    .filter(([, d]) => d.count >= 3)
    .map(([mid, d]) => {
      const avgConf = d.confSum / d.count;
      const actualWR = d.wins / d.count;
      const basis = actualWR - avgConf; // Positive = undervalued, negative = overvalued

      return {
        marketId: mid.slice(0, 20),
        category: d.category || "unknown",
        avgConfidence: round3(avgConf),
        actualWinRate: round3(actualWR),
        basis: round3(basis),
        basisBps: Math.round(basis * 10000),
        avgEdge: round3(d.edges.reduce((s, v) => s + v, 0) / d.edges.length),
        trades: d.count,
        signal: basis > 0.05 ? "undervalued" : basis < -0.05 ? "overvalued" : "fair"
      };
    });

  markets.sort((a, b) => Math.abs(b.basis) - Math.abs(a.basis));

  // Distribution stats
  const allBasis = markets.map(m => m.basis);
  const avgBasis = allBasis.length > 0 ? allBasis.reduce((s, v) => s + v, 0) / allBasis.length : 0;
  const basisStd = stddev(allBasis);

  // Divergences: markets with significant mispricing
  const divergences = markets.filter(m => Math.abs(m.basis) > 0.08).map(m => ({
    marketId: m.marketId,
    basis: m.basis,
    signal: m.signal,
    confidence: m.trades > 10 ? "high" : "moderate"
  }));

  return {
    markets: markets.slice(0, 15),
    avgBasis: round3(avgBasis),
    basisStd: round3(basisStd),
    divergences,
    divergenceCount: divergences.length,
    marketsAnalyzed: markets.length,
    totalTrades: rows.length,
    lookbackDays: days
  };
}

/**
 * Get basis by category.
 *
 * @param {number} days
 * @returns {{ categories, bestCategory, worstCategory }}
 */
export function getBasisByCategory(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT category,
           AVG(confidence) as avg_conf,
           SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
           COUNT(*) as trades,
           AVG(edge_at_entry) as avg_edge,
           SUM(realized_pnl) as total_pnl
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY category
    HAVING COUNT(*) >= 5
  `).all(daysOffset);

  const categories = rows.map(r => {
    const actualWR = r.wins / r.trades;
    const basis = actualWR - (r.avg_conf || 0.5);

    return {
      category: r.category || "unknown",
      avgConfidence: round3(r.avg_conf || 0),
      actualWinRate: round3(actualWR),
      basis: round3(basis),
      avgEdge: round3(r.avg_edge || 0),
      totalPnl: round2(r.total_pnl),
      trades: r.trades,
      calibration: Math.abs(basis) < 0.03 ? "well_calibrated"
        : basis > 0 ? "model_underestimates"
        : "model_overestimates"
    };
  });

  categories.sort((a, b) => b.basis - a.basis);

  return {
    categories,
    bestCategory: categories[0] || null,
    worstCategory: categories[categories.length - 1] || null,
    avgCalibrationError: round3(
      categories.reduce((s, c) => s + Math.abs(c.basis), 0) / (categories.length || 1)
    ),
    lookbackDays: days
  };
}

/**
 * Get basis mean-reversion signals.
 * Markets with extreme basis may revert.
 *
 * @param {number} days
 * @returns {{ signals, strongSignals }}
 */
export function getBasisRevertSignals(days = 14) {
  const overview = getBasisOverview(days);
  if (!overview.markets || overview.markets.length === 0) {
    return { signals: [], strongSignals: 0, message: "no_data" };
  }

  const signals = overview.markets
    .filter(m => Math.abs(m.basis) > 0.05 && m.trades >= 5)
    .map(m => ({
      marketId: m.marketId,
      category: m.category,
      basis: m.basis,
      direction: m.basis > 0 ? "buy" : "sell",
      strength: Math.abs(m.basis) > 0.10 ? "strong" : "moderate",
      confidence: m.trades > 15 ? "high" : "moderate",
      rationale: m.basis > 0
        ? `Model underestimates by ${(m.basis * 100).toFixed(1)}% — potential buy`
        : `Model overestimates by ${(Math.abs(m.basis) * 100).toFixed(1)}% — potential sell`
    }));

  signals.sort((a, b) => Math.abs(b.basis) - Math.abs(a.basis));

  return {
    signals: signals.slice(0, 10),
    strongSignals: signals.filter(s => s.strength === "strong").length,
    totalCandidates: signals.length
  };
}

/**
 * Get basis tracker dashboard.
 *
 * @returns {{ overview, categoryBasis, revertSignals, referenceCount }}
 */
export function getBasisDashboard() {
  const overview = getBasisOverview();
  const categories = getBasisByCategory();
  const signals = getBasisRevertSignals();

  return {
    avgBasis: overview.avgBasis || 0,
    basisStd: overview.basisStd || 0,
    divergenceCount: overview.divergenceCount || 0,
    marketsAnalyzed: overview.marketsAnalyzed || 0,
    topDivergence: overview.divergences?.[0] || null,
    avgCalibrationError: categories.avgCalibrationError || 0,
    bestCategory: categories.bestCategory?.category || "unknown",
    worstCategory: categories.worstCategory?.category || "unknown",
    strongRevertSignals: signals.strongSignals || 0,
    referenceCount: Object.keys(referenceStore).length
  };
}

function stddev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
