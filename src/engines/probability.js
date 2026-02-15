import { clamp } from "../utils.js";

export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim,
    orderbookImbalance
  } = inputs;

  let up = 1;
  let down = 1;

  // VWAP position
  if (price !== null && vwap !== null) {
    if (price > vwap) up += 2;
    if (price < vwap) down += 2;
  }

  // VWAP slope (trend direction)
  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 2;
    if (vwapSlope < 0) down += 2;
  }

  // RSI momentum
  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) up += 2;
    if (rsi < 45 && rsiSlope < 0) down += 2;
  }

  // MACD histogram expansion
  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 2;
    if (expandingRed) down += 2;

    if (macd.macd > 0) up += 1;
    if (macd.macd < 0) down += 1;
  }

  // Heiken Ashi streak
  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 2) up += 1;
    if (heikenColor === "red" && heikenCount >= 2) down += 1;
  }

  // Failed VWAP reclaim (bearish reversal pattern)
  if (failedVwapReclaim === true) down += 3;

  // Orderbook imbalance — bid/ask volume ratio from Polymarket CLOB
  // imbalance > 1.0 means more bid volume (buying pressure = bullish for YES)
  // imbalance < 1.0 means more ask volume (selling pressure = bearish for YES)
  if (orderbookImbalance != null && orderbookImbalance > 0) {
    if (orderbookImbalance > 1.5) {
      up += 2;    // Strong buy pressure
    } else if (orderbookImbalance > 1.2) {
      up += 1;    // Moderate buy pressure
    } else if (orderbookImbalance < 0.67) {
      down += 2;  // Strong sell pressure
    } else if (orderbookImbalance < 0.83) {
      down += 1;  // Moderate sell pressure
    }
  }

  const rawUp = up / (up + down);
  return { upScore: up, downScore: down, rawUp };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
