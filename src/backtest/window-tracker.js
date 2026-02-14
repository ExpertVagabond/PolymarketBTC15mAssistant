/**
 * Tracks every 15-minute window: open price, close price, all signals,
 * and outcome (UP/DOWN). On window rollover, records to outcomes.csv.
 */

import { appendCsvRow } from "../utils.js";
import { CONFIG } from "../config.js";

const WINDOW_MS = CONFIG.candleWindowMinutes * 60_000;

const outcomeHeader = [
  "window_id", "start_ms", "end_ms",
  "open_price", "close_price", "price_to_beat",
  "outcome", "delta_usd", "delta_pct",
  "signal_count", "buy_up_count", "buy_down_count",
  "avg_model_up", "avg_model_down",
  "regime_dominant"
];

export function createWindowTracker(opts = {}) {
  const csvPath = opts.csvPath ?? "./logs/outcomes.csv";
  let currentWindowId = null;
  let windowState = null;

  function newWindow(windowId, price, priceToBeat) {
    return {
      windowId,
      startMs: windowId * WINDOW_MS,
      endMs: (windowId + 1) * WINDOW_MS,
      openPrice: price,
      closePrice: price,
      priceToBeat,
      signals: [],
      modelUps: [],
      modelDowns: [],
      regimes: [],
      buyUpCount: 0,
      buyDownCount: 0
    };
  }

  function finalizeWindow(ws) {
    if (!ws || ws.signals.length === 0) return;

    const outcome = ws.priceToBeat !== null
      ? (ws.closePrice >= ws.priceToBeat ? "UP" : "DOWN")
      : (ws.closePrice >= ws.openPrice ? "UP" : "DOWN");

    const refPrice = ws.priceToBeat ?? ws.openPrice;
    const deltaUsd = ws.closePrice - refPrice;
    const deltaPct = refPrice !== 0 ? (deltaUsd / refPrice) * 100 : 0;

    const avgModelUp = ws.modelUps.length ? ws.modelUps.reduce((a, b) => a + b, 0) / ws.modelUps.length : null;
    const avgModelDown = ws.modelDowns.length ? ws.modelDowns.reduce((a, b) => a + b, 0) / ws.modelDowns.length : null;

    // dominant regime
    const regimeCounts = {};
    for (const r of ws.regimes) {
      regimeCounts[r] = (regimeCounts[r] || 0) + 1;
    }
    const regimeDominant = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UNKNOWN";

    appendCsvRow(csvPath, outcomeHeader, [
      ws.windowId,
      ws.startMs,
      ws.endMs,
      ws.openPrice,
      ws.closePrice,
      ws.priceToBeat,
      outcome,
      deltaUsd?.toFixed(2),
      deltaPct?.toFixed(4),
      ws.signals.length,
      ws.buyUpCount,
      ws.buyDownCount,
      avgModelUp?.toFixed(4),
      avgModelDown?.toFixed(4),
      regimeDominant
    ]);

    return { windowId: ws.windowId, outcome, deltaUsd, deltaPct, regimeDominant };
  }

  /**
   * Called on every poller tick. Returns finalized window info if a rollover just happened.
   */
  function onTick(tickState) {
    if (!tickState) return null;

    const windowId = tickState.windowId;
    const currentPrice = tickState.prices?.current ?? tickState.prices?.spot ?? null;
    const priceToBeat = tickState.prices?.priceToBeat ?? null;

    if (currentPrice === null) return null;

    let finalized = null;

    // window rollover
    if (currentWindowId !== null && windowId !== currentWindowId) {
      finalized = finalizeWindow(windowState);
      windowState = null;
    }

    // start new window if needed
    if (windowState === null) {
      currentWindowId = windowId;
      windowState = newWindow(windowId, currentPrice, priceToBeat);
    }

    // update window state
    windowState.closePrice = currentPrice;
    if (windowState.priceToBeat === null && priceToBeat !== null) {
      windowState.priceToBeat = priceToBeat;
    }

    windowState.signals.push(tickState.signal);
    if (tickState.signal === "BUY UP") windowState.buyUpCount++;
    if (tickState.signal === "BUY DOWN") windowState.buyDownCount++;

    if (tickState.timeAware?.adjustedUp != null) windowState.modelUps.push(tickState.timeAware.adjustedUp);
    if (tickState.timeAware?.adjustedDown != null) windowState.modelDowns.push(tickState.timeAware.adjustedDown);
    if (tickState.regimeInfo?.regime) windowState.regimes.push(tickState.regimeInfo.regime);

    return finalized;
  }

  function getCurrentWindow() {
    return windowState;
  }

  return { onTick, getCurrentWindow };
}
