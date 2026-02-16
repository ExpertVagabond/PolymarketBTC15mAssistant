/**
 * Market maker behavior detector.
 *
 * Profiles market maker activity patterns:
 * - Spread pattern analysis (tight vs wide, time-varying)
 * - Quoting intensity detection (active vs passive MM)
 * - Toxic flow identification (adverse selection signals)
 * - Order book imbalance profiling
 * - MM presence scoring per market/category
 *
 * Helps the trader avoid adverse selection and time entries better.
 */

import { getDb } from "../subscribers/db.js";

// In-memory spread/quote tracking
const spreadHistory = {};  // marketId → [{ bid, ask, spread, timestamp }]
const SPREAD_HISTORY_SIZE = 300;

/**
 * Record a spread observation.
 *
 * @param {string} marketId
 * @param {number} bid
 * @param {number} ask
 */
export function recordSpread(marketId, bid, ask) {
  if (!spreadHistory[marketId]) spreadHistory[marketId] = [];
  const spread = ask - bid;
  spreadHistory[marketId].push({ bid, ask, spread, midpoint: (bid + ask) / 2, timestamp: Date.now() });
  if (spreadHistory[marketId].length > SPREAD_HISTORY_SIZE) {
    spreadHistory[marketId] = spreadHistory[marketId].slice(-SPREAD_HISTORY_SIZE);
  }
}

/**
 * Detect market maker presence and behavior from trade patterns.
 *
 * @param {number} days
 * @returns {{ markets, mmPresenceScore, toxicFlowRisk, spreadPatterns }}
 */
export function detectMMBehavior(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT market_id, category, confidence, edge_at_entry,
           realized_pnl, status, quality_score, regime,
           CAST(strftime('%H', created_at) AS INTEGER) as hour
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
  `).all(daysOffset);

  if (rows.length < 15) {
    return { markets: [], message: "insufficient_data" };
  }

  // Per-market analysis
  const byMarket = {};
  for (const r of rows) {
    const mid = r.market_id || "unknown";
    if (!byMarket[mid]) byMarket[mid] = {
      trades: [], category: r.category, hourDist: {},
      wins: 0, losses: 0, totalPnl: 0, edges: [], qualities: []
    };
    const m = byMarket[mid];
    m.trades.push(r);
    m.totalPnl += r.realized_pnl;
    m.edges.push(r.edge_at_entry || 0);
    m.qualities.push(r.quality_score || 0);
    if (r.status === "WIN") m.wins++;
    else m.losses++;

    const h = r.hour || 0;
    m.hourDist[h] = (m.hourDist[h] || 0) + 1;
  }

  const markets = Object.entries(byMarket)
    .filter(([, d]) => d.trades.length >= 5)
    .map(([mid, d]) => {
      const total = d.wins + d.losses;
      const winRate = d.wins / total;
      const avgEdge = avg(d.edges);
      const avgQuality = avg(d.qualities);

      // Adverse selection: consistently negative edge suggests toxic flow
      const adverseSelection = avgEdge < -0.02;

      // Hour concentration: MM markets tend to have more uniform activity
      const hours = Object.keys(d.hourDist).length;
      const hourConcentration = hours < 4 ? "concentrated" : hours < 8 ? "moderate" : "dispersed";

      // Quality consistency: MM markets have more consistent quality
      const qualityStd = stddev(d.qualities);
      const qualityConsistent = qualityStd < 0.2;

      // MM presence heuristic score (0-100)
      let mmScore = 50;
      if (hourConcentration === "dispersed") mmScore += 15; // Active MM = more hours
      if (qualityConsistent) mmScore += 10;
      if (Math.abs(avgEdge) < 0.01) mmScore += 10; // Tight edges = competitive MM
      if (winRate > 0.4 && winRate < 0.6) mmScore += 10; // Fair pricing
      if (adverseSelection) mmScore -= 20;

      return {
        marketId: mid.slice(0, 20),
        category: d.category || "unknown",
        trades: total,
        winRate: round3(winRate),
        avgEdge: round3(avgEdge),
        avgQuality: round3(avgQuality),
        mmPresenceScore: Math.max(0, Math.min(100, Math.round(mmScore))),
        adverseSelection,
        hourConcentration,
        qualityConsistent,
        toxicFlowRisk: adverseSelection ? "high" : avgEdge < 0 ? "moderate" : "low"
      };
    });

  markets.sort((a, b) => b.mmPresenceScore - a.mmPresenceScore);

  // Overall toxic flow assessment
  const toxicMarkets = markets.filter(m => m.toxicFlowRisk === "high");
  const avgMMScore = markets.length > 0
    ? Math.round(markets.reduce((s, m) => s + m.mmPresenceScore, 0) / markets.length)
    : 0;

  return {
    markets: markets.slice(0, 15),
    marketsAnalyzed: markets.length,
    avgMMPresenceScore: avgMMScore,
    toxicFlowCount: toxicMarkets.length,
    toxicFlowRisk: toxicMarkets.length > markets.length * 0.3 ? "high"
      : toxicMarkets.length > 0 ? "moderate" : "low",
    totalTrades: rows.length,
    lookbackDays: days
  };
}

/**
 * Analyze spread patterns from in-memory data.
 *
 * @returns {{ markets, avgSpread, tightestMarket, widestMarket }}
 */
export function analyzeSpreadPatterns() {
  const marketIds = Object.keys(spreadHistory);
  if (marketIds.length === 0) {
    return { markets: [], message: "no_spread_data" };
  }

  const markets = marketIds.map(mid => {
    const history = spreadHistory[mid];
    const spreads = history.map(h => h.spread);
    const avgSpread = avg(spreads);
    const spreadVol = stddev(spreads);
    const currentSpread = spreads[spreads.length - 1];

    // Detect spread widening/tightening trend
    const recentSpreads = spreads.slice(-20);
    const olderSpreads = spreads.slice(-50, -20);
    const recentAvg = avg(recentSpreads);
    const olderAvg = olderSpreads.length > 0 ? avg(olderSpreads) : recentAvg;
    const trend = recentAvg > olderAvg * 1.2 ? "widening"
      : recentAvg < olderAvg * 0.8 ? "tightening" : "stable";

    return {
      marketId: mid.slice(0, 20),
      currentSpread: round4(currentSpread),
      avgSpread: round4(avgSpread),
      spreadVolatility: round4(spreadVol),
      observations: history.length,
      trend,
      mmActive: avgSpread < 0.03 && spreadVol < 0.01
    };
  });

  markets.sort((a, b) => a.avgSpread - b.avgSpread);

  return {
    markets: markets.slice(0, 15),
    totalMarkets: markets.length,
    avgSpread: round4(avg(markets.map(m => m.avgSpread))),
    tightestMarket: markets[0] || null,
    widestMarket: markets[markets.length - 1] || null
  };
}

/**
 * Get MM detector dashboard.
 *
 * @returns {{ mmPresenceScore, toxicFlowRisk, marketsAnalyzed, spreadData }}
 */
export function getMMDetectorDashboard() {
  const behavior = detectMMBehavior();
  const spreads = analyzeSpreadPatterns();

  return {
    avgMMPresenceScore: behavior.avgMMPresenceScore || 0,
    toxicFlowRisk: behavior.toxicFlowRisk || "unknown",
    toxicFlowCount: behavior.toxicFlowCount || 0,
    marketsAnalyzed: behavior.marketsAnalyzed || 0,
    spreadMarkets: spreads.totalMarkets || 0,
    avgSpread: spreads.avgSpread || 0,
    tightestMarket: spreads.tightestMarket?.marketId || "unknown",
    totalTrades: behavior.totalTrades || 0
  };
}

function avg(arr) { return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function stddev(arr) {
  if (arr.length === 0) return 0;
  const mean = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
function round4(v) { return Math.round((v ?? 0) * 10000) / 10000; }
