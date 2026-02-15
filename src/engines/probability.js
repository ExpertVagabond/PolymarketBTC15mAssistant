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

  // Degenerate indicator detection: when CLOB price barely moves,
  // RSI pins to extremes and MACD flatlines — these carry no real signal.
  const rsiDegenerate = rsi !== null && (rsi >= 99 || rsi <= 1);
  const macdDegenerate = macd && macd.macd === 0 && macd.signal === 0 && macd.hist === 0;
  const indicatorsDegenerate = rsiDegenerate && macdDegenerate;

  // If indicators are degenerate, skip momentum/trend scoring entirely
  // and only use orderbook imbalance (real market signal)
  if (indicatorsDegenerate) {
    // Only orderbook imbalance carries real signal on flat-price markets
    if (orderbookImbalance != null && orderbookImbalance > 0) {
      if (orderbookImbalance > 1.5) { up += 1; }
      else if (orderbookImbalance > 1.2) { up += 1; }
      else if (orderbookImbalance < 0.67) { down += 1; }
      else if (orderbookImbalance < 0.83) { down += 1; }
    }
    const rawUp = up / (up + down);
    return { upScore: up, downScore: down, rawUp, degenerate: true };
  }

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
  if (macd != null && macd.hist != null && macd.histDelta != null) {
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

/**
 * Apply time-awareness decay to model probability.
 *
 * For SHORT windows (remainingMinutes ≤ indicatorHorizon):
 *   Original behavior — confidence decreases as settlement approaches
 *   (less time = less predictable). Decay = remaining / horizon.
 *
 * For LONG windows (remainingMinutes > indicatorHorizon):
 *   Confidence decreases as settlement gets FURTHER away, because
 *   current indicators become less relevant. Decay = horizon / remaining.
 *
 * @param {number} rawUp        - Raw model probability (0-1)
 * @param {number} remainingMinutes - Time until market settles
 * @param {number} indicatorHorizon - How far out indicators are useful (minutes)
 */
export function applyTimeAwareness(rawUp, remainingMinutes, indicatorHorizon) {
  let timeDecay;
  if (remainingMinutes <= indicatorHorizon) {
    // Short-term: original behavior — confidence shrinks near expiry
    timeDecay = clamp(remainingMinutes / indicatorHorizon, 0, 1);
  } else {
    // Long-term: sqrt decay — indicators lose relevance gradually
    // sqrt(15/900) = 0.13 vs linear 0.017 — preserves some signal
    // sqrt(60/600) = 0.32 vs linear 0.10 — esports/sports still useful
    timeDecay = clamp(Math.sqrt(indicatorHorizon / remainingMinutes), 0, 1);
  }
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
