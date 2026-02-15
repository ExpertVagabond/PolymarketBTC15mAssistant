import { clamp } from "../utils.js";
import { getWeight } from "./weights.js";

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
    if (orderbookImbalance != null && orderbookImbalance > 0) {
      if (orderbookImbalance > 1.5) { up += 1; }
      else if (orderbookImbalance > 1.2) { up += 1; }
      else if (orderbookImbalance < 0.67) { down += 1; }
      else if (orderbookImbalance < 0.83) { down += 1; }
    }
    const rawUp = up / (up + down);
    return { upScore: up, downScore: down, rawUp, degenerate: true };
  }

  // --- Dynamic weights: each indicator's score is multiplied by a
  // learned weight based on how well that indicator state predicts wins.
  // Starts at 1.0 (neutral) and shifts toward 0.5-1.5 as outcomes accumulate. ---

  // VWAP position
  if (price !== null && vwap !== null) {
    const vwapPos = price > vwap ? "ABOVE" : price < vwap ? "BELOW" : "AT";
    const w = getWeight("vwap_position", vwapPos);
    if (price > vwap) up += 2 * w;
    if (price < vwap) down += 2 * w;
  }

  // VWAP slope (trend direction)
  if (vwapSlope !== null) {
    const slopeDir = vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";
    const w = getWeight("vwap_slope_dir", slopeDir);
    if (vwapSlope > 0) up += 2 * w;
    if (vwapSlope < 0) down += 2 * w;
  }

  // RSI momentum
  if (rsi !== null && rsiSlope !== null) {
    const rsiZone = rsi >= 70 ? "OVERBOUGHT" : rsi >= 55 ? "BULLISH" : rsi > 45 ? "NEUTRAL" : rsi > 30 ? "BEARISH" : "OVERSOLD";
    const w = getWeight("rsi_zone", rsiZone);
    if (rsi > 55 && rsiSlope > 0) up += 2 * w;
    if (rsi < 45 && rsiSlope < 0) down += 2 * w;
  }

  // MACD histogram expansion
  if (macd != null && macd.hist != null && macd.histDelta != null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    let macdState = "ZERO";
    if (expandingGreen) macdState = "EXPANDING_GREEN";
    else if (macd.hist > 0) macdState = "FADING_GREEN";
    else if (expandingRed) macdState = "EXPANDING_RED";
    else if (macd.hist < 0) macdState = "FADING_RED";
    const w = getWeight("macd_state", macdState);

    if (expandingGreen) up += 2 * w;
    if (expandingRed) down += 2 * w;
    if (macd.macd > 0) up += 1 * w;
    if (macd.macd < 0) down += 1 * w;
  }

  // Heiken Ashi streak
  if (heikenColor) {
    const w = getWeight("heiken_color", heikenColor);
    if (heikenColor === "green" && heikenCount >= 2) up += 1 * w;
    if (heikenColor === "red" && heikenCount >= 2) down += 1 * w;
  }

  // Failed VWAP reclaim (bearish reversal pattern)
  if (failedVwapReclaim === true) down += 3;

  // Orderbook imbalance
  if (orderbookImbalance != null && orderbookImbalance > 0) {
    const obZone = orderbookImbalance > 1.5 ? "STRONG_BID"
      : orderbookImbalance > 1.2 ? "BID"
      : orderbookImbalance < 0.67 ? "STRONG_ASK"
      : orderbookImbalance < 0.83 ? "ASK"
      : "BALANCED";
    const w = getWeight("ob_zone", obZone);

    if (orderbookImbalance > 1.5) up += 2 * w;
    else if (orderbookImbalance > 1.2) up += 1 * w;
    else if (orderbookImbalance < 0.67) down += 2 * w;
    else if (orderbookImbalance < 0.83) down += 1 * w;
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
