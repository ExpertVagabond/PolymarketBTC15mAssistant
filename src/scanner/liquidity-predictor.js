/**
 * Market liquidity predictor.
 *
 * Predicts near-term tradability of markets based on observable features:
 * - Volume trend (growing = higher future liquidity)
 * - Spread tightness (tight spreads = market maker presence)
 * - Market age (new markets ramp up, old markets wind down)
 * - Category (crypto markets typically more liquid)
 * - Time to settlement (liquidity drops as expiry approaches)
 *
 * Produces a 0-100 predicted liquidity score used by:
 * - Scanner to prioritize which markets to poll
 * - Trading gates to reject illiquid markets
 * - Dashboard for market quality overview
 */

import { getDb } from "../subscribers/db.js";

// Category liquidity base scores (empirical)
const CATEGORY_BASE = {
  crypto: 75, Bitcoin: 75, Ethereum: 70,
  Sports: 60, Esports: 45,
  Politics: 65, Elections: 65,
  Economics: 55, Weather: 40,
  Science: 35, Entertainment: 45
};

const DEFAULT_BASE = 50;

// In-memory cache of market features
const marketFeatures = {};

/**
 * Record market features for liquidity prediction.
 * Call from scanner on each poll.
 *
 * @param {string} marketId
 * @param {object} features
 * @param {number} features.volume24h - 24h volume in USD
 * @param {number} features.spread - bid-ask spread (0-1)
 * @param {number} features.bidDepth - total bid volume in top 10 levels
 * @param {number} features.askDepth - total ask volume in top 10 levels
 * @param {string} features.category - market category
 * @param {number} features.minutesToSettlement - time until market resolves
 * @param {number} features.marketAgeHours - hours since market creation
 */
export function recordMarketFeatures(marketId, features) {
  if (!marketId) return;
  marketFeatures[marketId] = {
    ...features,
    timestamp: Date.now()
  };
}

/**
 * Predict liquidity for a specific market.
 * @param {string} marketId
 * @returns {{ score: number, quality: string, components: object }|null}
 */
export function predictLiquidity(marketId) {
  const f = marketFeatures[marketId];
  if (!f) return null;

  // Component scores (each 0-100)

  // 1. Volume score: higher volume = more liquid
  const vol = f.volume24h || 0;
  const volumeScore = Math.min(100, Math.round(
    vol >= 50000 ? 100
    : vol >= 10000 ? 70 + (vol - 10000) / 40000 * 30
    : vol >= 1000 ? 40 + (vol - 1000) / 9000 * 30
    : vol >= 100 ? 10 + (vol - 100) / 900 * 30
    : vol / 100 * 10
  ));

  // 2. Spread score: tighter = better
  const spread = f.spread ?? 0.1;
  const spreadScore = Math.round(
    spread <= 0.01 ? 100
    : spread <= 0.03 ? 80 + (0.03 - spread) / 0.02 * 20
    : spread <= 0.08 ? 50 + (0.08 - spread) / 0.05 * 30
    : spread <= 0.15 ? 20 + (0.15 - spread) / 0.07 * 30
    : Math.max(0, 20 - (spread - 0.15) * 200)
  );

  // 3. Depth score: more resting orders = more liquid
  const totalDepth = (f.bidDepth || 0) + (f.askDepth || 0);
  const depthScore = Math.min(100, Math.round(totalDepth / 5)); // $500 total depth = 100

  // 4. Category base score
  const catScore = CATEGORY_BASE[f.category] ?? DEFAULT_BASE;

  // 5. Settlement proximity: liquidity drops near expiry
  const minsToSettle = f.minutesToSettlement ?? 10000;
  const settlementScore = minsToSettle > 1440 ? 100 // >24h = full
    : minsToSettle > 360 ? 70 + (minsToSettle - 360) / 1080 * 30
    : minsToSettle > 60 ? 30 + (minsToSettle - 60) / 300 * 40
    : Math.max(0, minsToSettle / 60 * 30); // Last hour: drops to 0

  // 6. Market age: new markets ramp up, need time
  const ageHours = f.marketAgeHours ?? 100;
  const ageScore = ageHours >= 48 ? 100
    : ageHours >= 12 ? 60 + (ageHours - 12) / 36 * 40
    : ageHours >= 2 ? 20 + (ageHours - 2) / 10 * 40
    : ageHours / 2 * 20;

  // Weighted composite
  const score = Math.round(
    volumeScore * 0.25 +
    spreadScore * 0.20 +
    depthScore * 0.20 +
    catScore * 0.10 +
    settlementScore * 0.15 +
    ageScore * 0.10
  );

  const quality = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  return {
    marketId,
    score: Math.max(0, Math.min(100, score)),
    quality,
    components: {
      volume: { value: vol, score: volumeScore },
      spread: { value: Math.round(spread * 10000) / 10000, score: spreadScore },
      depth: { value: Math.round(totalDepth), score: depthScore },
      category: { value: f.category || "unknown", score: catScore },
      settlement: { value: minsToSettle, score: Math.round(settlementScore) },
      age: { value: Math.round(ageHours), score: Math.round(ageScore) }
    }
  };
}

/**
 * Get liquidity rankings for all tracked markets.
 * @returns {{ markets: object[], summary: object }}
 */
export function getLiquidityRankings() {
  const rankings = [];

  for (const marketId of Object.keys(marketFeatures)) {
    const pred = predictLiquidity(marketId);
    if (pred) rankings.push(pred);
  }

  rankings.sort((a, b) => b.score - a.score);

  const scores = rankings.map(r => r.score);
  const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0;

  return {
    markets: rankings.slice(0, 30),
    summary: {
      totalMarkets: rankings.length,
      avgLiquidityScore: avgScore,
      highLiquidity: rankings.filter(r => r.quality === "high").length,
      mediumLiquidity: rankings.filter(r => r.quality === "medium").length,
      lowLiquidity: rankings.filter(r => r.quality === "low").length,
      overallQuality: avgScore >= 60 ? "healthy" : avgScore >= 35 ? "fair" : "poor"
    }
  };
}

/**
 * Get liquidity forecast — combines current predictions with historical patterns.
 * @returns {object}
 */
export function getLiquidityForecast() {
  const rankings = getLiquidityRankings();

  // Identify markets at risk (low and dropping)
  const atRisk = rankings.markets
    .filter(m => m.score < 40)
    .map(m => ({
      marketId: m.marketId,
      score: m.score,
      mainIssue: getMainIssue(m.components)
    }));

  // Identify best opportunities
  const opportunities = rankings.markets
    .filter(m => m.score >= 60)
    .slice(0, 10)
    .map(m => ({
      marketId: m.marketId,
      score: m.score,
      strength: getMainStrength(m.components)
    }));

  return {
    ...rankings.summary,
    atRisk: atRisk.slice(0, 10),
    opportunities,
    recommendation: atRisk.length > rankings.summary.totalMarkets * 0.5
      ? "Many markets have low liquidity. Consider reducing position sizes."
      : opportunities.length > 5
      ? "Strong liquidity across markets. Normal trading conditions."
      : "Mixed liquidity conditions. Monitor individual markets."
  };
}

function getMainIssue(components) {
  const scores = [
    { name: "volume", score: components.volume.score },
    { name: "spread", score: components.spread.score },
    { name: "depth", score: components.depth.score },
    { name: "settlement", score: components.settlement.score }
  ];
  scores.sort((a, b) => a.score - b.score);
  return scores[0].name;
}

function getMainStrength(components) {
  const scores = [
    { name: "volume", score: components.volume.score },
    { name: "spread", score: components.spread.score },
    { name: "depth", score: components.depth.score }
  ];
  scores.sort((a, b) => b.score - a.score);
  return scores[0].name;
}
