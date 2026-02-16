/**
 * Cross-market correlation engine.
 *
 * Tracks BTC as the "macro signal" and uses it to influence related markets.
 * BTC direction affects: ETH price targets, crypto Up/Down markets, etc.
 *
 * Shared indicator state avoids redundant Binance API calls across pollers.
 */

import { fetchKlines, fetchLastPrice } from "../data/binance.js";
import { computeRsi, slopeLast } from "../indicators/rsi.js";
import { computeVwapSeries } from "../indicators/vwap.js";
import { computeMacd } from "../indicators/macd.js";
import { computeATR, classifyVolatility } from "../indicators/volatility.js";

// Shared BTC state — computed once, used by all crypto pollers
let btcState = null;
let btcLastUpdatedMs = 0;
const BTC_REFRESH_MS = 15_000; // Refresh BTC state every 15s

// ETH state for ETH-specific markets
let ethState = null;
let ethLastUpdatedMs = 0;

/**
 * Compute the macro indicator state for a given symbol.
 */
async function computeMacroState(symbol, interval = "1m", limit = 240) {
  const candles = await fetchKlines({ interval, limit });
  if (!candles.length) return null;

  const closes = candles.map((c) => c.close);
  const lastPrice = closes[closes.length - 1];

  const vwapSeries = computeVwapSeries(candles);
  const vwapNow = vwapSeries[vwapSeries.length - 1];
  const vwapSlope = vwapSeries.length >= 5
    ? (vwapNow - vwapSeries[vwapSeries.length - 5]) / 5
    : null;

  const rsi = computeRsi(closes, 14);
  const rsiSeries = [];
  for (let i = 0; i < closes.length; i++) {
    const r = computeRsi(closes.slice(0, i + 1), 14);
    if (r !== null) rsiSeries.push(r);
  }
  const rsiSlope = slopeLast(rsiSeries, 3);

  const macd = computeMacd(closes, 12, 26, 9);
  const atrData = computeATR(candles, 14);

  // Determine overall bias
  let bullishVotes = 0;
  let bearishVotes = 0;

  if (vwapNow && lastPrice > vwapNow) bullishVotes++;
  else if (vwapNow && lastPrice < vwapNow) bearishVotes++;

  if (rsi > 55) bullishVotes++;
  else if (rsi < 45) bearishVotes++;

  if (macd && macd.hist > 0) bullishVotes++;
  else if (macd && macd.hist < 0) bearishVotes++;

  if (vwapSlope > 0) bullishVotes++;
  else if (vwapSlope < 0) bearishVotes++;

  let bias = "NEUTRAL";
  let biasStrength = 0;
  if (bullishVotes >= 3) {
    bias = "BULLISH";
    biasStrength = bullishVotes / 4;
  } else if (bearishVotes >= 3) {
    bias = "BEARISH";
    biasStrength = bearishVotes / 4;
  } else if (bullishVotes > bearishVotes) {
    bias = "LEAN_BULL";
    biasStrength = (bullishVotes - bearishVotes) / 4;
  } else if (bearishVotes > bullishVotes) {
    bias = "LEAN_BEAR";
    biasStrength = (bearishVotes - bullishVotes) / 4;
  }

  return {
    symbol,
    lastPrice,
    rsi,
    rsiSlope,
    vwap: vwapNow,
    vwapSlope,
    macdHist: macd?.hist ?? null,
    atrPct: atrData?.atrPct ?? null,
    bias,
    biasStrength,
    updatedAt: Date.now()
  };
}

/**
 * Get current BTC macro state (cached, refreshes every 15s).
 */
export async function getBtcMacroState() {
  if (btcState && Date.now() - btcLastUpdatedMs < BTC_REFRESH_MS) {
    return btcState;
  }

  try {
    btcState = await computeMacroState("BTCUSDT");
    btcLastUpdatedMs = Date.now();
  } catch {
    // Keep stale state on error
  }

  return btcState;
}

/**
 * Compute a correlation adjustment for a market based on BTC macro state.
 *
 * Returns a multiplier that adjusts the market's model probability:
 * - BTC strongly bullish + market is "above X price" → boost YES
 * - BTC strongly bearish + market is "above X price" → suppress YES
 * - BTC neutral → no adjustment
 *
 * @param {object} market - Market object with category, question, tags
 * @param {string} signalSide - "UP" or "DOWN"
 * @returns {{ correlationAdj: number, reason: string }}
 */
export function computeCorrelationAdj(market, signalSide) {
  if (!btcState) return { correlationAdj: 1.0, reason: "no_btc_data" };

  const cat = market.category || "";
  const tags = Array.isArray(market.tags) ? market.tags : [];
  const question = (market.question || "").toLowerCase();

  // Only apply to crypto-related markets
  const isCryptoRelated = ["Bitcoin", "Ethereum", "crypto", "Crypto", "Crypto Prices", "Up or Down", "15M"]
    .some((t) => cat === t || tags.includes(t));

  if (!isCryptoRelated) {
    return { correlationAdj: 1.0, reason: "non_crypto" };
  }

  // Determine if this market benefits from BTC going up or down
  const isAboveMarket = /above|over|higher/i.test(question);
  const isBelowMarket = /below|under|lower/i.test(question);
  const isUpDown = cat === "Up or Down" || cat === "15M";

  const { bias, biasStrength } = btcState;

  // For "Will BTC be above $X" markets:
  // BTC bullish → boost YES, BTC bearish → suppress YES
  if (isAboveMarket || isUpDown) {
    if (bias === "BULLISH" && signalSide === "UP") {
      return { correlationAdj: 1.0 + biasStrength * 0.3, reason: "btc_bullish_aligns" };
    }
    if (bias === "BEARISH" && signalSide === "UP") {
      return { correlationAdj: 1.0 - biasStrength * 0.3, reason: "btc_bearish_conflicts" };
    }
    if (bias === "BEARISH" && signalSide === "DOWN") {
      return { correlationAdj: 1.0 + biasStrength * 0.3, reason: "btc_bearish_aligns" };
    }
    if (bias === "BULLISH" && signalSide === "DOWN") {
      return { correlationAdj: 1.0 - biasStrength * 0.3, reason: "btc_bullish_conflicts" };
    }
  }

  // For ETH markets when BTC is trending strongly
  const isEth = tags.includes("Ethereum") || /ethereum|eth/i.test(question);
  if (isEth) {
    // ETH generally follows BTC — apply a dampened correlation
    if (bias === "BULLISH" && signalSide === "UP") {
      return { correlationAdj: 1.0 + biasStrength * 0.2, reason: "btc_bullish_eth_follows" };
    }
    if (bias === "BEARISH" && signalSide === "DOWN") {
      return { correlationAdj: 1.0 + biasStrength * 0.2, reason: "btc_bearish_eth_follows" };
    }
    if (bias === "BEARISH" && signalSide === "UP") {
      return { correlationAdj: 1.0 - biasStrength * 0.2, reason: "btc_bearish_eth_conflicts" };
    }
  }

  // Lean adjustments (smaller)
  if (bias === "LEAN_BULL" && signalSide === "UP" && isCryptoRelated) {
    return { correlationAdj: 1.05, reason: "btc_leaning_bullish" };
  }
  if (bias === "LEAN_BEAR" && signalSide === "DOWN" && isCryptoRelated) {
    return { correlationAdj: 1.05, reason: "btc_leaning_bearish" };
  }

  return { correlationAdj: 1.0, reason: "neutral" };
}

/* ── Cross-market portfolio correlation ── */

import { getDb } from "../subscribers/db.js";

/**
 * Compute pairwise correlation matrix for markets with recent activity.
 * Uses daily average market_yes prices as the series.
 * @param {number} days - Lookback window (default 30)
 * @param {number} minDataPoints - Minimum overlapping days required (default 5)
 * @returns {{ markets, matrix, clusters, diversityScore, pairs, totalMarkets, days }}
 */
export function computeCorrelationMatrix(days = 30, minDataPoints = 5) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 180)} days`;

  const rows = db.prepare(`
    SELECT
      market_id,
      DATE(created_at) as day,
      AVG(market_yes) as avg_price,
      COUNT(*) as signals
    FROM signal_history
    WHERE signal != 'NO TRADE'
      AND market_yes IS NOT NULL
      AND created_at >= datetime('now', ?)
    GROUP BY market_id, DATE(created_at)
    ORDER BY market_id, day
  `).all(daysOffset);

  // Group by market
  const marketSeries = {};
  for (const r of rows) {
    if (!marketSeries[r.market_id]) marketSeries[r.market_id] = {};
    marketSeries[r.market_id][r.day] = r.avg_price;
  }

  const markets = Object.keys(marketSeries).filter(
    m => Object.keys(marketSeries[m]).length >= minDataPoints
  );

  if (markets.length < 2) {
    return { markets, matrix: [], clusters: [], diversityScore: 100, pairs: [], totalMarkets: markets.length, days };
  }

  // Compute daily returns per market
  const marketReturns = {};
  for (const m of markets) {
    const sorted = Object.entries(marketSeries[m]).sort((a, b) => a[0].localeCompare(b[0]));
    const returns = {};
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1][1];
      if (prev === 0) continue;
      returns[sorted[i][0]] = (sorted[i][1] - prev) / Math.abs(prev);
    }
    marketReturns[m] = returns;
  }

  // Pairwise Pearson correlations
  const n = markets.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(0));
  const pairs = [];

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const corr = pearsonCorr(marketReturns[markets[i]], marketReturns[markets[j]], minDataPoints);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
      if (corr !== null && Math.abs(corr) >= 0.3) {
        pairs.push({ marketA: markets[i], marketB: markets[j], correlation: corr });
      }
    }
  }

  pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  const clusters = detectCorrelationClusters(markets, matrix, 0.5);
  const diversityScore = portfolioDiversityScore(matrix, n);

  return {
    markets: markets.slice(0, 50),
    matrix: matrix.slice(0, 50).map(row => row.slice(0, 50).map(v => v !== null ? Math.round(v * 100) / 100 : null)),
    clusters,
    diversityScore,
    pairs: pairs.slice(0, 30),
    totalMarkets: markets.length,
    days
  };
}

/** Pearson correlation between two return series keyed by date. */
function pearsonCorr(seriesA, seriesB, minOverlap = 5) {
  const commonDays = Object.keys(seriesA).filter(d => d in seriesB);
  if (commonDays.length < minOverlap) return null;

  const a = commonDays.map(d => seriesA[d]);
  const b = commonDays.map(d => seriesB[d]);
  const n = a.length;

  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : null;
}

/** Cluster detection using correlation threshold. */
function detectCorrelationClusters(markets, matrix, threshold = 0.5) {
  const n = markets.length;
  const visited = new Set();
  const clusters = [];

  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;
    const cluster = [i];
    visited.add(i);

    for (let j = i + 1; j < n; j++) {
      if (visited.has(j)) continue;
      if (matrix[i][j] !== null && matrix[i][j] >= threshold) {
        cluster.push(j);
        visited.add(j);
      }
    }

    if (cluster.length > 1) {
      let totalCorr = 0, count = 0;
      for (let a = 0; a < cluster.length; a++) {
        for (let b = a + 1; b < cluster.length; b++) {
          if (matrix[cluster[a]][cluster[b]] !== null) {
            totalCorr += matrix[cluster[a]][cluster[b]];
            count++;
          }
        }
      }
      clusters.push({
        markets: cluster.map(idx => markets[idx]),
        size: cluster.length,
        avgCorrelation: count > 0 ? Math.round(totalCorr / count * 100) / 100 : null
      });
    }
  }
  return clusters;
}

/** Portfolio diversity score (0-100). 100 = perfectly uncorrelated. */
function portfolioDiversityScore(matrix, n) {
  if (n < 2) return 100;
  let totalAbsCorr = 0, count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (matrix[i][j] !== null) {
        totalAbsCorr += Math.abs(matrix[i][j]);
        count++;
      }
    }
  }
  if (count === 0) return 100;
  return Math.round((1 - totalAbsCorr / count) * 100);
}

/**
 * Get correlation data for open positions specifically.
 */
export function getOpenPositionCorrelations() {
  const db = getDb();
  const openPositions = db.prepare(
    "SELECT DISTINCT market_id, category, question FROM trade_executions WHERE status = 'open'"
  ).all();

  if (openPositions.length < 2) {
    return { positions: openPositions.length, correlatedPairs: [], riskLevel: "low" };
  }

  const full = computeCorrelationMatrix(30, 3);
  const openMarketIds = new Set(openPositions.map(p => p.market_id));
  const correlatedPairs = full.pairs.filter(
    p => openMarketIds.has(p.marketA) && openMarketIds.has(p.marketB) && p.correlation >= 0.4
  );

  let riskLevel = "low";
  if (correlatedPairs.length >= 3 || correlatedPairs.some(p => p.correlation >= 0.7)) {
    riskLevel = "high";
  } else if (correlatedPairs.length >= 1) {
    riskLevel = "medium";
  }

  return {
    positions: openPositions.length,
    correlatedPairs,
    riskLevel,
    openMarkets: openPositions.map(p => ({ marketId: p.market_id, category: p.category, question: p.question?.slice(0, 60) }))
  };
}

/**
 * Check if a new market would add too much correlation to open portfolio.
 * @param {string} marketId
 * @param {number} threshold - Max acceptable correlation (default 0.7)
 * @returns {{ blocked, reason, highestCorrelation, correlatedWith }}
 */
export function checkCorrelationRisk(marketId, threshold = 0.7) {
  const db = getDb();
  const openMarketIds = db.prepare(
    "SELECT DISTINCT market_id FROM trade_executions WHERE status = 'open'"
  ).all().map(r => r.market_id);

  if (openMarketIds.length === 0 || openMarketIds.includes(marketId)) {
    return { blocked: false, reason: null, highestCorrelation: null, correlatedWith: null };
  }

  const candidateReturns = getSingleMarketReturns(marketId, 30);
  if (!candidateReturns || Object.keys(candidateReturns).length < 3) {
    return { blocked: false, reason: null, highestCorrelation: null, correlatedWith: null };
  }

  let highestCorr = 0;
  let correlatedWith = null;

  for (const openId of openMarketIds) {
    const openReturns = getSingleMarketReturns(openId, 30);
    if (!openReturns || Object.keys(openReturns).length < 3) continue;

    const corr = pearsonCorr(candidateReturns, openReturns, 3);
    if (corr !== null && corr > highestCorr) {
      highestCorr = corr;
      correlatedWith = openId;
    }
  }

  if (highestCorr >= threshold) {
    return {
      blocked: true,
      reason: `correlation_risk (r=${highestCorr.toFixed(2)} with ${correlatedWith})`,
      highestCorrelation: Math.round(highestCorr * 100) / 100,
      correlatedWith
    };
  }

  return { blocked: false, reason: null, highestCorrelation: Math.round(highestCorr * 100) / 100, correlatedWith };
}

/** Get daily returns for a single market. */
function getSingleMarketReturns(marketId, days = 30) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DATE(created_at) as day, AVG(market_yes) as avg_price
    FROM signal_history
    WHERE market_id = ? AND market_yes IS NOT NULL
      AND created_at >= datetime('now', ?)
    GROUP BY DATE(created_at)
    ORDER BY day ASC
  `).all(marketId, `-${days} days`);

  if (rows.length < 2) return null;

  const returns = {};
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].avg_price;
    if (prev === 0) continue;
    returns[rows[i].day] = (rows[i].avg_price - prev) / Math.abs(prev);
  }
  return Object.keys(returns).length > 0 ? returns : null;
}
