/**
 * Multi-timeframe confluence engine.
 *
 * Fetches multiple candle intervals for crypto markets and checks whether
 * all timeframes agree on direction. Higher confluence = higher confidence.
 *
 * Timeframes: 1m (micro), 5m (short), 15m (medium)
 * Each timeframe contributes: VWAP position, RSI direction, MACD direction.
 * Confluence score = number of timeframes agreeing (0-3).
 */

import { fetchKlines } from "../data/binance.js";
import { computeVwapSeries } from "../indicators/vwap.js";
import { computeRsi, slopeLast } from "../indicators/rsi.js";
import { computeMacd } from "../indicators/macd.js";
import { CONFIG } from "../config.js";

// Cache to avoid hammering Binance on every poll cycle
// Key: "{symbol}:{interval}", Value: { data, fetchedAt }
const cache = new Map();
const CACHE_TTL_MS = {
  "1m": 30_000,   // 30s cache for 1m candles
  "5m": 60_000,   // 1m cache for 5m candles
  "15m": 120_000  // 2m cache for 15m candles
};

async function getCachedKlines(interval, limit) {
  const key = `${CONFIG.symbol}:${interval}`;
  const cached = cache.get(key);
  const ttl = CACHE_TTL_MS[interval] || 60_000;

  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return cached.data;
  }

  const data = await fetchKlines({ interval, limit });
  cache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

/**
 * Analyze a single timeframe and return its directional bias.
 * @returns {{ direction: "UP"|"DOWN"|"NEUTRAL", strength: number }}
 */
function analyzeTimeframe(candles) {
  if (!candles || candles.length < 30) {
    return { direction: "NEUTRAL", strength: 0 };
  }

  const closes = candles.map((c) => c.close);
  const lastPrice = closes[closes.length - 1];

  // VWAP
  const vwapSeries = computeVwapSeries(candles);
  const vwapNow = vwapSeries[vwapSeries.length - 1];
  const vwapBullish = vwapNow ? lastPrice > vwapNow : null;

  // RSI
  const rsi = computeRsi(closes, 14);
  const rsiSeries = [];
  for (let i = 0; i < closes.length; i++) {
    const r = computeRsi(closes.slice(0, i + 1), 14);
    if (r !== null) rsiSeries.push(r);
  }
  const rsiSlope = slopeLast(rsiSeries, 3);
  const rsiBullish = rsi !== null ? rsi > 50 : null;

  // MACD
  const macd = computeMacd(closes, 12, 26, 9);
  const macdBullish = macd ? macd.hist > 0 : null;

  // Count bullish/bearish votes
  let bullish = 0;
  let bearish = 0;
  const votes = [vwapBullish, rsiBullish, macdBullish];

  for (const v of votes) {
    if (v === true) bullish++;
    else if (v === false) bearish++;
  }

  if (bullish >= 2 && bullish > bearish) {
    return { direction: "UP", strength: bullish / 3, rsi, vwapBullish, macdBullish };
  }
  if (bearish >= 2 && bearish > bullish) {
    return { direction: "DOWN", strength: bearish / 3, rsi, vwapBullish, macdBullish };
  }
  return { direction: "NEUTRAL", strength: 0, rsi, vwapBullish, macdBullish };
}

/**
 * Compute multi-timeframe confluence for crypto markets.
 *
 * @returns {{
 *   confluence: number,        // 0-3: how many timeframes agree
 *   direction: "UP"|"DOWN"|"MIXED",
 *   timeframes: { "1m": {...}, "5m": {...}, "15m": {...} },
 *   confluenceMultiplier: number  // Scoring multiplier: 0.5 (conflicting) to 1.3 (full agreement)
 * }}
 */
export async function computeConfluence() {
  try {
    const [candles1m, candles5m, candles15m] = await Promise.all([
      getCachedKlines("1m", 120),
      getCachedKlines("5m", 60),
      getCachedKlines("15m", 60)
    ]);

    const tf1m = analyzeTimeframe(candles1m);
    const tf5m = analyzeTimeframe(candles5m);
    const tf15m = analyzeTimeframe(candles15m);

    const timeframes = { "1m": tf1m, "5m": tf5m, "15m": tf15m };
    const directions = [tf1m.direction, tf5m.direction, tf15m.direction].filter((d) => d !== "NEUTRAL");

    const upCount = directions.filter((d) => d === "UP").length;
    const downCount = directions.filter((d) => d === "DOWN").length;

    let direction = "MIXED";
    let confluence = 0;

    if (upCount > 0 && downCount === 0) {
      direction = "UP";
      confluence = upCount;
    } else if (downCount > 0 && upCount === 0) {
      direction = "DOWN";
      confluence = downCount;
    } else if (upCount > downCount) {
      direction = "UP";
      confluence = upCount - downCount; // Partial confluence
    } else if (downCount > upCount) {
      direction = "DOWN";
      confluence = downCount - upCount;
    }

    // Multiplier: full confluence boosts signals, conflicting timeframes suppress
    let confluenceMultiplier;
    if (confluence >= 3) {
      confluenceMultiplier = 1.3;  // All three agree — high confidence
    } else if (confluence === 2) {
      confluenceMultiplier = 1.15; // Two agree — moderate boost
    } else if (confluence === 1) {
      confluenceMultiplier = 1.0;  // One direction only — neutral
    } else {
      confluenceMultiplier = 0.7;  // Conflicting — suppress
    }

    return { confluence, direction, timeframes, confluenceMultiplier };
  } catch {
    return { confluence: 0, direction: "MIXED", timeframes: {}, confluenceMultiplier: 1.0 };
  }
}
