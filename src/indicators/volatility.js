/**
 * Volatility indicators: ATR (Average True Range) and Bollinger Band width.
 *
 * ATR measures average candle range — high ATR = volatile, noisy market.
 * Bollinger width measures price dispersion — tight bands = breakout pending.
 * Both are used to adjust signal thresholds dynamically.
 */

/**
 * Compute Average True Range.
 * True Range = max(high - low, abs(high - prevClose), abs(low - prevClose))
 *
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {number} period - ATR smoothing period (default 14)
 * @returns {{ atr: number, atrPct: number, atrSeries: number[] } | null}
 */
export function computeATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // EMA-smoothed ATR
  const k = 2 / (period + 1);
  const atrSeries = [];
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrSeries.push(atr);

  for (let i = period; i < trueRanges.length; i++) {
    atr = trueRanges[i] * k + atr * (1 - k);
    atrSeries.push(atr);
  }

  const lastPrice = candles[candles.length - 1].close;
  const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;

  return { atr, atrPct, atrSeries };
}

/**
 * Compute Bollinger Band width (normalized).
 * Width = (upper - lower) / middle = 2 * stdDev * multiplier / SMA
 *
 * @param {number[]} closes
 * @param {number} period - SMA/stddev period (default 20)
 * @param {number} multiplier - Band multiplier (default 2)
 * @returns {{ width: number, upper: number, lower: number, middle: number, squeeze: boolean } | null}
 */
export function computeBollingerWidth(closes, period = 20, multiplier = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;

  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, v) => a + (v - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + multiplier * stdDev;
  const lower = middle - multiplier * stdDev;
  const width = middle > 0 ? (upper - lower) / middle : 0;

  // Squeeze detection: width below 20-period average width
  // (simplified: width < 2% is a squeeze)
  const squeeze = width < 0.02;

  return { width, upper, lower, middle, stdDev, squeeze };
}

/**
 * Classify volatility regime from ATR percentage.
 *
 * @param {number} atrPct - ATR as percentage of price
 * @param {string} category - Market category for calibration
 * @returns {{ volRegime: string, volMultiplier: number }}
 */
export function classifyVolatility(atrPct, category) {
  // Thresholds vary by category
  // Crypto: normally 0.1-0.5% per candle (1m), spikes to 1%+
  // CLOB: normally 0.5-3% (hourly), spikes to 5%+
  const isCrypto = ["crypto", "Bitcoin", "Ethereum", "Up or Down", "15M", "Crypto", "Crypto Prices"].includes(category);

  const lowThresh = isCrypto ? 0.05 : 0.5;
  const highThresh = isCrypto ? 0.3 : 3.0;

  if (atrPct < lowThresh) {
    // Low vol: tight ranges, small edges are meaningful
    return { volRegime: "LOW_VOL", volMultiplier: 0.8 };
  }
  if (atrPct > highThresh) {
    // High vol: noisy, need bigger edges to cut through noise
    return { volRegime: "HIGH_VOL", volMultiplier: 1.5 };
  }
  // Normal vol
  return { volRegime: "NORMAL_VOL", volMultiplier: 1.0 };
}
