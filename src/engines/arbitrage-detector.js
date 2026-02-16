/**
 * Cross-market arbitrage detector.
 *
 * Detects exploitable price discrepancies across related markets:
 * - Complementary markets: YES + NO should sum to ~$1.00
 * - Correlated markets: similar events should have correlated prices
 * - Category clusters: markets in same category that diverge unexpectedly
 * - Implied probability mismatches: when market prices violate probability axioms
 *
 * Produces opportunities with estimated edge, confidence, and required capital.
 */

import { getDb } from "../subscribers/db.js";

// In-memory price tracker for real-time arbitrage scanning
const marketPrices = {};

/**
 * Record a market price snapshot for arbitrage detection.
 * Call from scanner on each poll.
 *
 * @param {string} marketId
 * @param {object} data
 * @param {number} data.yesPrice - YES outcome price (0-1)
 * @param {number} data.noPrice - NO outcome price (0-1)
 * @param {string} data.category
 * @param {string} data.question - Market question text
 * @param {number} data.volume24h
 * @param {number} data.spread
 */
export function recordMarketPrice(marketId, data) {
  if (!marketId) return;
  marketPrices[marketId] = {
    ...data,
    timestamp: Date.now()
  };
}

/**
 * Scan all tracked markets for arbitrage opportunities.
 *
 * @returns {{ opportunities: object[], summary: object }}
 */
export function scanArbitrageOpportunities() {
  const markets = Object.entries(marketPrices);
  if (markets.length < 2) {
    return { opportunities: [], summary: { marketsScanned: markets.length, opportunitiesFound: 0 } };
  }

  const opportunities = [];
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();

  // Filter fresh markets
  const fresh = markets.filter(([, m]) => now - m.timestamp < staleThreshold);

  // 1. Complementary check: YES + NO should be ~1.0
  for (const [id, m] of fresh) {
    const yp = m.yesPrice ?? 0;
    const np = m.noPrice ?? 0;
    const sum = yp + np;

    if (sum > 0 && Math.abs(sum - 1.0) > 0.02) {
      // Prices don't sum to 1.0 — arbitrage exists
      const edge = Math.abs(sum - 1.0);
      const direction = sum > 1.0
        ? "overpriced" // Both outcomes sum > $1 — sell both
        : "underpriced"; // Both outcomes sum < $1 — buy both

      opportunities.push({
        type: "complementary_mismatch",
        marketId: id,
        category: m.category,
        yesPrice: yp,
        noPrice: np,
        sum: Math.round(sum * 10000) / 10000,
        edgeBps: Math.round(edge * 10000),
        direction,
        confidence: edge > 0.05 ? "high" : edge > 0.03 ? "medium" : "low",
        action: direction === "overpriced"
          ? "Sell YES and NO — guaranteed profit when sum > $1"
          : "Buy YES and NO — guaranteed profit when sum < $1",
        estimatedProfitPer100: Math.round(Math.abs(sum - 1.0) * 100 * 100) / 100
      });
    }
  }

  // 2. Category cluster divergence: find markets in same category with unusual spreads
  const byCat = {};
  for (const [id, m] of fresh) {
    const cat = m.category || "unknown";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push({ id, ...m });
  }

  for (const [cat, catMarkets] of Object.entries(byCat)) {
    if (catMarkets.length < 3) continue;

    const yesPrices = catMarkets.map(m => m.yesPrice ?? 0.5);
    const mean = yesPrices.reduce((s, v) => s + v, 0) / yesPrices.length;
    const stdDev = Math.sqrt(yesPrices.reduce((s, v) => s + (v - mean) ** 2, 0) / yesPrices.length);

    if (stdDev === 0) continue;

    for (const m of catMarkets) {
      const zScore = Math.abs((m.yesPrice ?? 0.5) - mean) / stdDev;
      if (zScore > 2.0) {
        opportunities.push({
          type: "category_outlier",
          marketId: m.id,
          category: cat,
          yesPrice: m.yesPrice,
          categoryMean: Math.round(mean * 10000) / 10000,
          zScore: Math.round(zScore * 100) / 100,
          edgeBps: Math.round(Math.abs((m.yesPrice ?? 0.5) - mean) * 10000),
          direction: (m.yesPrice ?? 0.5) > mean ? "overpriced_vs_peers" : "underpriced_vs_peers",
          confidence: zScore > 3.0 ? "high" : "medium",
          peerCount: catMarkets.length
        });
      }
    }
  }

  // 3. Cross-market correlation: find pairs with divergent prices but similar questions
  // Use volume-weighted price as reference for each category
  for (const [cat, catMarkets] of Object.entries(byCat)) {
    if (catMarkets.length < 2) continue;

    // Sort by volume — higher volume markets are more reliable price signals
    const sorted = [...catMarkets].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
    const reference = sorted[0]; // Highest-volume market as price anchor

    for (let i = 1; i < sorted.length; i++) {
      const other = sorted[i];
      const refPrice = reference.yesPrice ?? 0.5;
      const otherPrice = other.yesPrice ?? 0.5;
      const spread = Math.abs(refPrice - otherPrice);

      if (spread > 0.15 && (other.volume24h ?? 0) > 1000) {
        opportunities.push({
          type: "cross_market_divergence",
          referenceMarket: reference.id,
          divergentMarket: other.id,
          category: cat,
          referencePrice: refPrice,
          divergentPrice: otherPrice,
          spreadBps: Math.round(spread * 10000),
          referenceVolume: reference.volume24h ?? 0,
          divergentVolume: other.volume24h ?? 0,
          confidence: spread > 0.25 ? "high" : "medium"
        });
      }
    }
  }

  // Sort by edge
  opportunities.sort((a, b) => (b.edgeBps ?? 0) - (a.edgeBps ?? 0));

  return {
    opportunities: opportunities.slice(0, 20),
    summary: {
      marketsScanned: fresh.length,
      staleMarkets: markets.length - fresh.length,
      opportunitiesFound: opportunities.length,
      byType: {
        complementary: opportunities.filter(o => o.type === "complementary_mismatch").length,
        categoryOutlier: opportunities.filter(o => o.type === "category_outlier").length,
        crossMarket: opportunities.filter(o => o.type === "cross_market_divergence").length
      },
      highConfidence: opportunities.filter(o => o.confidence === "high").length,
      totalEstimatedEdgeBps: opportunities.reduce((s, o) => s + (o.edgeBps ?? 0), 0)
    }
  };
}

/**
 * Get arbitrage heatmap — which categories have the most mispricing?
 *
 * @returns {{ categories: object[], overallMispricingScore: number }}
 */
export function getArbitrageHeatmap() {
  const { opportunities } = scanArbitrageOpportunities();

  const catScores = {};
  for (const opp of opportunities) {
    const cat = opp.category || "unknown";
    if (!catScores[cat]) catScores[cat] = { count: 0, totalEdgeBps: 0, highConf: 0 };
    catScores[cat].count++;
    catScores[cat].totalEdgeBps += opp.edgeBps ?? 0;
    if (opp.confidence === "high") catScores[cat].highConf++;
  }

  const categories = Object.entries(catScores)
    .map(([cat, s]) => ({
      category: cat,
      opportunityCount: s.count,
      avgEdgeBps: s.count > 0 ? Math.round(s.totalEdgeBps / s.count) : 0,
      highConfidenceCount: s.highConf,
      mispricingScore: Math.min(100, Math.round(s.totalEdgeBps / 10 + s.highConf * 20))
    }))
    .sort((a, b) => b.mispricingScore - a.mispricingScore);

  const overall = categories.length > 0
    ? Math.round(categories.reduce((s, c) => s + c.mispricingScore, 0) / categories.length)
    : 0;

  return {
    categories,
    overallMispricingScore: overall,
    totalOpportunities: opportunities.length,
    assessment: overall > 50 ? "Significant mispricing detected across markets."
      : overall > 20 ? "Moderate mispricing — selective opportunities exist."
      : "Markets are efficiently priced."
  };
}
