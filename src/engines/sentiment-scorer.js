/**
 * Market sentiment scorer.
 *
 * Derives bullish/bearish/neutral sentiment from observable market microdata
 * without external APIs. Uses:
 * - Price momentum: rising YES prices = bullish
 * - Volume acceleration: increasing volume = conviction
 * - Spread compression: tightening spreads = market maker confidence
 * - Orderbook imbalance: bid-heavy = bullish, ask-heavy = bearish
 * - Volatility regime: low vol = complacent, high vol = uncertain
 *
 * Produces per-market and per-category sentiment scores (-100 to +100):
 * - +100 = extremely bullish
 * -    0 = neutral
 * - -100 = extremely bearish
 */

// In-memory sentiment data ring buffers
const marketSentiment = {};
const MAX_HISTORY = 30; // Keep last 30 snapshots per market

/**
 * Record market data for sentiment computation.
 * Call from scanner on each poll.
 *
 * @param {string} marketId
 * @param {object} data
 * @param {number} data.yesPrice - Current YES price (0-1)
 * @param {number} data.volume24h - 24h volume in USD
 * @param {number} data.spread - Current bid-ask spread
 * @param {number} data.bidDepth - Bid depth in top levels
 * @param {number} data.askDepth - Ask depth in top levels
 * @param {string} data.category - Market category
 */
export function recordSentimentData(marketId, data) {
  if (!marketId) return;

  if (!marketSentiment[marketId]) {
    marketSentiment[marketId] = {
      category: data.category || "unknown",
      history: []
    };
  }

  const entry = marketSentiment[marketId];
  entry.category = data.category || entry.category;
  entry.history.push({
    yesPrice: data.yesPrice ?? 0.5,
    volume24h: data.volume24h ?? 0,
    spread: data.spread ?? 0.1,
    bidDepth: data.bidDepth ?? 0,
    askDepth: data.askDepth ?? 0,
    timestamp: Date.now()
  });

  // Ring buffer
  if (entry.history.length > MAX_HISTORY) {
    entry.history = entry.history.slice(-MAX_HISTORY);
  }
}

/**
 * Compute sentiment score for a specific market.
 *
 * @param {string} marketId
 * @returns {{ score: number, label: string, components: object }|null}
 */
export function getMarketSentiment(marketId) {
  const entry = marketSentiment[marketId];
  if (!entry || entry.history.length < 3) return null;

  const h = entry.history;
  const latest = h[h.length - 1];
  const oldest = h[0];
  const mid = h[Math.floor(h.length / 2)];

  // 1. Price momentum (-100 to +100)
  const priceDelta = latest.yesPrice - oldest.yesPrice;
  const recentDelta = latest.yesPrice - mid.yesPrice;
  // Weight recent momentum more heavily
  const momentumRaw = (priceDelta * 0.4 + recentDelta * 0.6) * 200;
  const momentumScore = clamp(momentumRaw, -100, 100);

  // 2. Volume acceleration (-100 to +100)
  const volRecent = h.slice(-5).reduce((s, x) => s + x.volume24h, 0) / Math.min(5, h.length);
  const volOlder = h.slice(0, Math.max(1, h.length - 5)).reduce((s, x) => s + x.volume24h, 0) / Math.max(1, h.length - 5);
  const volRatio = volOlder > 0 ? volRecent / volOlder : 1;
  // Volume increasing + price up = very bullish; volume increasing + price down = very bearish
  const volDirection = priceDelta >= 0 ? 1 : -1;
  const volumeScore = clamp((volRatio - 1) * 100 * volDirection, -100, 100);

  // 3. Spread compression (-100 to +100)
  const spreadRecent = h.slice(-5).reduce((s, x) => s + x.spread, 0) / Math.min(5, h.length);
  const spreadOlder = h.slice(0, Math.max(1, h.length - 5)).reduce((s, x) => s + x.spread, 0) / Math.max(1, h.length - 5);
  // Tightening spreads = confident (bullish for YES)
  const spreadRatio = spreadOlder > 0 ? spreadRecent / spreadOlder : 1;
  const spreadScore = clamp((1 - spreadRatio) * 150 * (priceDelta >= 0 ? 1 : -1), -100, 100);

  // 4. Orderbook imbalance (-100 to +100)
  const totalDepth = latest.bidDepth + latest.askDepth;
  const imbalance = totalDepth > 0 ? (latest.bidDepth - latest.askDepth) / totalDepth : 0;
  const imbalanceScore = clamp(imbalance * 200, -100, 100);

  // 5. Volatility signal (-100 to +100)
  const prices = h.map(x => x.yesPrice);
  const priceStd = stddev(prices);
  // High volatility = uncertainty = tends toward 0 (neutral)
  // Low volatility near extremes = conviction
  const extremity = Math.abs(latest.yesPrice - 0.5) * 2; // 0 at 50/50, 1 at extremes
  const volSignal = clamp((extremity - priceStd * 5) * 100, -100, 100);
  // Direction based on price position
  const volatilityScore = latest.yesPrice > 0.5 ? volSignal : -volSignal;

  // Weighted composite
  const composite = Math.round(
    momentumScore * 0.30 +
    volumeScore * 0.25 +
    imbalanceScore * 0.20 +
    spreadScore * 0.15 +
    volatilityScore * 0.10
  );

  const score = clamp(composite, -100, 100);
  const label = score > 40 ? "strongly_bullish"
    : score > 15 ? "bullish"
    : score > -15 ? "neutral"
    : score > -40 ? "bearish"
    : "strongly_bearish";

  return {
    marketId,
    category: entry.category,
    score,
    label,
    components: {
      momentum: { score: Math.round(momentumScore), weight: 0.30 },
      volume: { score: Math.round(volumeScore), weight: 0.25 },
      imbalance: { score: Math.round(imbalanceScore), weight: 0.20 },
      spread: { score: Math.round(spreadScore), weight: 0.15 },
      volatility: { score: Math.round(volatilityScore), weight: 0.10 }
    },
    dataPoints: h.length,
    latestPrice: latest.yesPrice
  };
}

/**
 * Get aggregate sentiment across all markets.
 *
 * @returns {{ markets: object[], byCategory: object[], overall: object }}
 */
export function getAggregateSentiment() {
  const results = [];

  for (const marketId of Object.keys(marketSentiment)) {
    const s = getMarketSentiment(marketId);
    if (s) results.push(s);
  }

  if (results.length === 0) {
    return {
      markets: [],
      byCategory: [],
      overall: { score: 0, label: "neutral", marketCount: 0 }
    };
  }

  // Sort by absolute sentiment strength
  results.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  // Category aggregation
  const catMap = {};
  for (const r of results) {
    const cat = r.category || "unknown";
    if (!catMap[cat]) catMap[cat] = { scores: [], count: 0 };
    catMap[cat].scores.push(r.score);
    catMap[cat].count++;
  }

  const byCategory = Object.entries(catMap)
    .map(([cat, data]) => {
      const avg = Math.round(data.scores.reduce((s, v) => s + v, 0) / data.scores.length);
      return {
        category: cat,
        avgScore: avg,
        label: avg > 40 ? "strongly_bullish" : avg > 15 ? "bullish" : avg > -15 ? "neutral" : avg > -40 ? "bearish" : "strongly_bearish",
        marketCount: data.count,
        bullish: data.scores.filter(s => s > 15).length,
        bearish: data.scores.filter(s => s < -15).length,
        neutral: data.scores.filter(s => s >= -15 && s <= 15).length
      };
    })
    .sort((a, b) => b.avgScore - a.avgScore);

  // Overall market sentiment
  const allScores = results.map(r => r.score);
  const overallScore = Math.round(allScores.reduce((s, v) => s + v, 0) / allScores.length);

  return {
    markets: results.slice(0, 20),
    byCategory,
    overall: {
      score: overallScore,
      label: overallScore > 40 ? "strongly_bullish" : overallScore > 15 ? "bullish" : overallScore > -15 ? "neutral" : overallScore > -40 ? "bearish" : "strongly_bearish",
      marketCount: results.length,
      bullishPct: Math.round(results.filter(r => r.score > 15).length / results.length * 1000) / 1000,
      bearishPct: Math.round(results.filter(r => r.score < -15).length / results.length * 1000) / 1000,
      neutralPct: Math.round(results.filter(r => r.score >= -15 && r.score <= 15).length / results.length * 1000) / 1000
    }
  };
}

/**
 * Get sentiment momentum — is sentiment shifting?
 *
 * @returns {{ shifting: boolean, direction: string, magnitude: number, details: object[] }}
 */
export function getSentimentMomentum() {
  const results = [];

  for (const [marketId, entry] of Object.entries(marketSentiment)) {
    if (entry.history.length < 10) continue;

    const h = entry.history;
    const recentPrices = h.slice(-5).map(x => x.yesPrice);
    const olderPrices = h.slice(-10, -5).map(x => x.yesPrice);

    const recentAvg = recentPrices.reduce((s, v) => s + v, 0) / recentPrices.length;
    const olderAvg = olderPrices.reduce((s, v) => s + v, 0) / olderPrices.length;
    const shift = recentAvg - olderAvg;

    if (Math.abs(shift) > 0.02) {
      results.push({
        marketId,
        category: entry.category,
        shift: Math.round(shift * 10000) / 10000,
        direction: shift > 0 ? "bullish_shift" : "bearish_shift",
        magnitude: Math.round(Math.abs(shift) * 10000)
      });
    }
  }

  results.sort((a, b) => b.magnitude - a.magnitude);

  const bullishShifts = results.filter(r => r.direction === "bullish_shift").length;
  const bearishShifts = results.filter(r => r.direction === "bearish_shift").length;
  const netDirection = bullishShifts > bearishShifts ? "bullish" : bearishShifts > bullishShifts ? "bearish" : "neutral";

  return {
    shifting: results.length > 0,
    direction: netDirection,
    magnitude: results.length > 0 ? results[0].magnitude : 0,
    bullishShifts,
    bearishShifts,
    details: results.slice(0, 10)
  };
}

// Utility functions
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function stddev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}
