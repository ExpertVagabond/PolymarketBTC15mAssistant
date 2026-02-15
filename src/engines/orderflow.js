/**
 * Order flow analysis engine.
 *
 * Analyzes Polymarket CLOB orderbook snapshots for:
 * - Wall detection: large resting orders that act as support/resistance
 * - Multi-level depth imbalance: bid vs ask volume across N levels
 * - Spread analysis: wide spreads = uncertainty, tight = consensus
 * - Price pressure: where the weight of orders is concentrated
 *
 * Produces a composite order flow score (-100 to +100):
 * Positive = buy pressure (bullish), Negative = sell pressure (bearish)
 */

/**
 * Analyze a full orderbook snapshot for one side of a market.
 *
 * @param {object} book - Raw CLOB orderbook { bids: [{price, size}], asks: [{price, size}] }
 * @param {object} opts
 * @param {number} opts.wallThreshold - Size multiple over median to count as a wall (default: 5x)
 * @param {number} opts.depthLevels   - How many levels deep to analyze (default: 10)
 * @returns {object} Order flow analysis
 */
export function analyzeOrderbook(book, opts = {}) {
  const wallThreshold = opts.wallThreshold ?? 5;
  const depthLevels = opts.depthLevels ?? 10;

  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  if (bids.length === 0 && asks.length === 0) {
    return {
      bidDepth: 0, askDepth: 0, depthImbalance: 0,
      spread: null, spreadPct: null,
      bidWalls: [], askWalls: [],
      pressureScore: 0, pressureLabel: "EMPTY",
      weightedBidPrice: null, weightedAskPrice: null
    };
  }

  // Parse and sort
  const parsedBids = bids.map(l => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(l => isFinite(l.price) && isFinite(l.size) && l.size > 0)
    .sort((a, b) => b.price - a.price); // Highest bid first

  const parsedAsks = asks.map(l => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(l => isFinite(l.price) && isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price); // Lowest ask first

  // Depth: total volume in top N levels
  const topBids = parsedBids.slice(0, depthLevels);
  const topAsks = parsedAsks.slice(0, depthLevels);
  const bidDepth = topBids.reduce((s, l) => s + l.size, 0);
  const askDepth = topAsks.reduce((s, l) => s + l.size, 0);

  // Depth imbalance: -1 (all asks) to +1 (all bids)
  const totalDepth = bidDepth + askDepth;
  const depthImbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  // Spread
  const bestBid = parsedBids[0]?.price ?? null;
  const bestAsk = parsedAsks[0]?.price ?? null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const midPrice = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const spreadPct = spread != null && midPrice > 0 ? spread / midPrice : null;

  // Volume-weighted average prices (shows where the mass of orders sits)
  const weightedBidPrice = bidDepth > 0
    ? topBids.reduce((s, l) => s + l.price * l.size, 0) / bidDepth
    : null;
  const weightedAskPrice = askDepth > 0
    ? topAsks.reduce((s, l) => s + l.price * l.size, 0) / askDepth
    : null;

  // Wall detection: orders significantly larger than median
  const allSizes = [...topBids, ...topAsks].map(l => l.size).sort((a, b) => a - b);
  const medianSize = allSizes.length > 0 ? allSizes[Math.floor(allSizes.length / 2)] : 0;
  const wallMin = medianSize * wallThreshold;

  const bidWalls = wallMin > 0
    ? topBids.filter(l => l.size >= wallMin).map(l => ({ price: l.price, size: l.size, ratio: l.size / medianSize }))
    : [];
  const askWalls = wallMin > 0
    ? topAsks.filter(l => l.size >= wallMin).map(l => ({ price: l.price, size: l.size, ratio: l.size / medianSize }))
    : [];

  // Composite pressure score (-100 to +100)
  // Components:
  // 1. Depth imbalance (weight: 40%)
  // 2. Wall asymmetry (weight: 30%)
  // 3. Spread position — if price is closer to bids, sellers are more aggressive (weight: 30%)
  let pressureScore = 0;

  // Depth component
  pressureScore += depthImbalance * 40;

  // Wall component: more bid walls = support = bullish, more ask walls = resistance = bearish
  const bidWallVol = bidWalls.reduce((s, w) => s + w.size, 0);
  const askWallVol = askWalls.reduce((s, w) => s + w.size, 0);
  const wallTotal = bidWallVol + askWallVol;
  if (wallTotal > 0) {
    pressureScore += ((bidWallVol - askWallVol) / wallTotal) * 30;
  }

  // Spread position component: if weighted bid is close to mid, bids are aggressive
  if (weightedBidPrice != null && weightedAskPrice != null && midPrice != null) {
    const bidAggression = midPrice > 0 ? (weightedBidPrice - midPrice) / midPrice : 0;
    const askAggression = midPrice > 0 ? (midPrice - weightedAskPrice) / midPrice : 0;
    pressureScore += (bidAggression - askAggression) * 30 * 100; // Scale up since diffs are small
  }

  pressureScore = Math.max(-100, Math.min(100, Math.round(pressureScore)));

  // Label
  let pressureLabel = "NEUTRAL";
  if (pressureScore >= 40) pressureLabel = "STRONG_BUY";
  else if (pressureScore >= 15) pressureLabel = "BUY";
  else if (pressureScore <= -40) pressureLabel = "STRONG_SELL";
  else if (pressureScore <= -15) pressureLabel = "SELL";

  return {
    bidDepth: Math.round(bidDepth),
    askDepth: Math.round(askDepth),
    depthImbalance: Math.round(depthImbalance * 1000) / 1000,
    spread,
    spreadPct: spreadPct != null ? Math.round(spreadPct * 10000) / 10000 : null,
    bidWalls,
    askWalls,
    pressureScore,
    pressureLabel,
    weightedBidPrice,
    weightedAskPrice
  };
}

/**
 * Analyze order flow for a full market (both YES and NO books).
 *
 * @param {object} yesBook - YES token orderbook
 * @param {object} noBook  - NO token orderbook
 * @param {string} signalSide - "UP" or "DOWN" (which side we're considering)
 * @returns {object} Combined order flow analysis
 */
export function analyzeMarketOrderFlow(yesBook, noBook, signalSide) {
  const yesFlow = analyzeOrderbook(yesBook);
  const noFlow = analyzeOrderbook(noBook);

  // For signal alignment:
  // If signal is UP (buy YES), positive YES pressure + negative NO pressure = aligned
  // If signal is DOWN (buy NO), positive NO pressure + negative YES pressure = aligned
  let alignedScore;
  if (signalSide === "UP") {
    alignedScore = yesFlow.pressureScore - noFlow.pressureScore;
  } else {
    alignedScore = noFlow.pressureScore - yesFlow.pressureScore;
  }

  // Normalize to -100..+100
  alignedScore = Math.max(-100, Math.min(100, Math.round(alignedScore / 2)));

  // Flow quality: is the orderbook deep enough to matter?
  const totalDepth = yesFlow.bidDepth + yesFlow.askDepth + noFlow.bidDepth + noFlow.askDepth;
  const flowQuality = totalDepth > 10000 ? "DEEP" : totalDepth > 1000 ? "MODERATE" : "THIN";

  // Spread quality
  const avgSpreadPct = [yesFlow.spreadPct, noFlow.spreadPct].filter(s => s != null);
  const meanSpread = avgSpreadPct.length > 0 ? avgSpreadPct.reduce((a, b) => a + b, 0) / avgSpreadPct.length : null;
  const spreadQuality = meanSpread == null ? "UNKNOWN"
    : meanSpread < 0.02 ? "TIGHT"
    : meanSpread < 0.05 ? "NORMAL"
    : "WIDE";

  return {
    yes: yesFlow,
    no: noFlow,
    alignedScore,
    flowQuality,
    spreadQuality,
    totalDepth: Math.round(totalDepth),
    // Summary: does the order flow support the signal?
    flowSupports: alignedScore > 10,
    flowConflicts: alignedScore < -10
  };
}
