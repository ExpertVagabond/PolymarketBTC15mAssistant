/**
 * CLOB candle adapter: fetches price history from Polymarket CLOB API
 * and converts to the same { open, high, low, close, volume } format
 * used by Binance klines. Works for ANY market (crypto, politics, sports).
 */

import { CONFIG } from "../config.js";

/**
 * Fetch CLOB price history for a token.
 * @param {string} tokenId - CLOB token ID
 * @param {string} interval - "1m", "1h", "6h", "1d", "1w", "max"
 * @param {number} fidelity - Data point density (1-60, lower = more points)
 */
export async function fetchClobPriceHistory(tokenId, { interval = "1h", fidelity = 1 } = {}) {
  const url = new URL("/prices-history", CONFIG.clobBaseUrl);
  url.searchParams.set("market", tokenId);
  url.searchParams.set("interval", interval);
  url.searchParams.set("fidelity", String(fidelity));

  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();

  // API returns { history: [{ t: timestamp, p: price }] }
  const history = Array.isArray(data?.history) ? data.history : (Array.isArray(data) ? data : []);
  return history;
}

/**
 * Convert CLOB price history to candle format compatible with existing indicators.
 * Since CLOB only gives price (no OHLCV), we synthesize candles from price ticks.
 */
export function pricesToCandles(priceHistory, windowMs = 60_000) {
  if (!priceHistory.length) return [];

  const candles = [];
  let currentWindowStart = null;
  let candle = null;

  for (const point of priceHistory) {
    const t = Number(point.t) * 1000; // API returns seconds
    const p = Number(point.p);
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;

    const windowStart = Math.floor(t / windowMs) * windowMs;

    if (currentWindowStart !== windowStart) {
      if (candle) candles.push(candle);
      currentWindowStart = windowStart;
      candle = { open: p, high: p, low: p, close: p, volume: 0, timestamp: windowStart };
    }

    if (p > candle.high) candle.high = p;
    if (p < candle.low) candle.low = p;
    candle.close = p;
    candle.volume += 1; // tick count as proxy for volume
  }

  if (candle) candles.push(candle);
  return candles;
}

/**
 * Fetch and convert CLOB price history to candles.
 * Drop-in replacement for Binance fetchKlines for non-crypto markets.
 */
export async function fetchClobCandles(tokenId, { interval = "1h", limit = 240 } = {}) {
  const history = await fetchClobPriceHistory(tokenId, { interval, fidelity: 1 });
  const candles = pricesToCandles(history);
  return candles.slice(-limit);
}
