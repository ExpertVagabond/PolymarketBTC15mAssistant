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
