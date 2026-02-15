/**
 * Settlement monitor: tracks open trading positions and closes them on market settlement
 * or when take-profit/stop-loss thresholds are hit.
 *
 * Integrates with risk-manager to properly decrement openPositions and track P&L.
 * Places actual SELL orders when TRADING_DRY_RUN=false.
 */

import { recordTradeClose } from "./risk-manager.js";
import { placeSellOrderWithRetry } from "./clob-orders.js";
import { closeExecution } from "./execution-log.js";
import { isMonitorActive, checkDrainComplete } from "./bot-control.js";
import { logAuditEvent } from "./audit-log.js";
import { getConfigValue } from "./trading-config.js";
import { broadcastTradeEvent } from "../web/ws-handler.js";
import { CONFIG } from "../config.js";

const CHECK_INTERVAL_MS = 60_000; // 1 minute
const DRY_RUN = (process.env.TRADING_DRY_RUN || "true").toLowerCase() !== "false";

// In-memory ledger of open trades (maps signal ID to trade info)
const openTrades = new Map();
let monitorTimer = null;
let consecutiveClobFailures = 0;

/**
 * Fetch a single token's current price from the CLOB API (with retry).
 */
async function fetchTokenPrice(tokenId) {
  if (!tokenId) return null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const url = new URL("/price", CONFIG.clobBaseUrl);
      url.searchParams.set("token_id", tokenId);
      url.searchParams.set("side", "BUY");
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        if (attempt < 3 && (res.status >= 500 || res.status === 429)) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        return null;
      }
      const data = await res.json();
      return data.price != null ? Number(data.price) : null;
    } catch {
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return null;
}

/**
 * Register a new trade for monitoring.
 * Called when bot.js opens a position (live or dry-run).
 */
export function registerTrade({ signalId, marketId, tokenId, side, entryPrice, betSize, dryRun, executionId }) {
  openTrades.set(signalId, {
    signalId,
    marketId,
    tokenId,
    side,
    entryPrice,
    betSize,
    dryRun: !!dryRun,
    executionId: executionId || null,
    openedAt: Date.now(),
    highestPrice: entryPrice,       // peak price tracking for trailing stop
    breakevenActivated: false        // becomes true once breakeven trigger hit
  });
}

/**
 * Execute a close order (live or dry-run).
 */
async function executeClose(trade, closeReason, currentPrice, pnlPct, pnlUsd) {
  // Update risk manager
  recordTradeClose(pnlUsd);

  // Update execution log if we have an execution ID
  if (trade.executionId) {
    try {
      closeExecution(trade.executionId, { exitPrice: currentPrice, pnlUsd, pnlPct, closeReason });
    } catch { /* non-fatal */ }
  }

  // Place actual SELL order for live trades (non-settled)
  let sellResult = null;
  if (!trade.dryRun && !DRY_RUN && closeReason !== "SETTLED_WIN" && closeReason !== "SETTLED_LOSS") {
    try {
      sellResult = await placeSellOrderWithRetry({ tokenId: trade.tokenId, amount: trade.betSize });
      if (!sellResult.ok) {
        console.warn(`[settlement] SELL order failed for signal #${trade.signalId}: ${JSON.stringify(sellResult.data)}`);
      }
    } catch (err) {
      console.warn(`[settlement] SELL order error for signal #${trade.signalId}: ${err.message}`);
    }
  }

  console.log(
    `[settlement] ${closeReason} | Signal #${trade.signalId} | ` +
    `${trade.side} @ ${trade.entryPrice.toFixed(3)} -> ${currentPrice.toFixed(3)} | ` +
    `P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% ($${pnlUsd.toFixed(2)}) | ` +
    `${trade.dryRun ? "DRY RUN" : "LIVE"}` +
    (sellResult ? ` | Sell: ${sellResult.ok ? "OK" : "FAILED"}` : "")
  );

  // Audit log the close
  logAuditEvent("POSITION_CLOSED", {
    executionId: trade.executionId,
    marketId: trade.marketId,
    tokenId: trade.tokenId,
    side: trade.side,
    price: currentPrice,
    pnlUsd: pnlUsd,
    dryRun: trade.dryRun,
    detail: { closeReason, pnlPct, sellResult: sellResult?.ok ?? null }
  });

  // Broadcast to WS clients
  broadcastTradeEvent("POSITION_CLOSED", {
    executionId: trade.executionId,
    marketId: trade.marketId,
    side: trade.side,
    closeReason,
    entryPrice: trade.entryPrice,
    exitPrice: currentPrice,
    highestPrice: trade.highestPrice,
    pnlPct,
    pnlUsd,
    dryRun: trade.dryRun,
    holdMinutes: Math.round((Date.now() - trade.openedAt) / 60_000)
  });

  openTrades.delete(trade.signalId);

  // Check if drain mode should complete
  checkDrainComplete(openTrades.size);
}

/**
 * Check all open trades for settlement, take-profit, stop-loss, trailing stop,
 * breakeven stop, and max hold time.
 */
async function checkOpenTrades() {
  if (openTrades.size === 0) return;
  if (!isMonitorActive()) return;

  // Read dynamic config each cycle
  const TAKE_PROFIT_PCT = getConfigValue("take_profit_pct");
  const STOP_LOSS_PCT = getConfigValue("stop_loss_pct");
  const TRAILING_STOP_PCT = getConfigValue("trailing_stop_pct");
  const BREAKEVEN_TRIGGER_PCT = getConfigValue("breakeven_trigger_pct");
  const MAX_HOLD_HOURS = getConfigValue("max_hold_hours");

  let priceFetchFails = 0;
  let priceFetchOk = 0;

  for (const [signalId, trade] of openTrades) {
    try {
      // Fetch current price from CLOB
      const currentPrice = await fetchTokenPrice(trade.tokenId);
      if (currentPrice == null) { priceFetchFails++; continue; }
      priceFetchOk++;

      // Update peak price
      if (currentPrice > trade.highestPrice) {
        trade.highestPrice = currentPrice;
      }

      // Check if market has settled (price at 0 or 1)
      const settled = currentPrice >= 0.99 || currentPrice <= 0.01;

      // Calculate unrealized P&L %
      const pnlPct = trade.entryPrice > 0
        ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
        : 0;

      // Calculate drawdown from peak
      const drawdownFromPeak = trade.highestPrice > 0
        ? ((trade.highestPrice - currentPrice) / trade.highestPrice) * 100
        : 0;

      // Check breakeven activation
      if (!trade.breakevenActivated && pnlPct >= BREAKEVEN_TRIGGER_PCT) {
        trade.breakevenActivated = true;
        console.log(`[settlement] Breakeven stop activated for signal #${trade.signalId} (pnl: +${pnlPct.toFixed(1)}%)`);
      }

      // Check hold time
      const holdHours = (Date.now() - trade.openedAt) / (1000 * 60 * 60);

      let closeReason = null;

      if (settled) {
        closeReason = currentPrice >= 0.99 ? "SETTLED_WIN" : "SETTLED_LOSS";
      } else if (pnlPct >= TAKE_PROFIT_PCT) {
        closeReason = "TAKE_PROFIT";
      } else if (pnlPct <= STOP_LOSS_PCT) {
        closeReason = "STOP_LOSS";
      } else if (drawdownFromPeak >= TRAILING_STOP_PCT && pnlPct > 0) {
        // Trailing stop: only triggers when position is still profitable
        closeReason = "TRAILING_STOP";
      } else if (trade.breakevenActivated && currentPrice <= trade.entryPrice) {
        // Breakeven stop: once triggered, close if price returns to entry
        closeReason = "BREAKEVEN_STOP";
      } else if (holdHours >= MAX_HOLD_HOURS) {
        closeReason = "MAX_HOLD_TIME";
      }

      if (closeReason) {
        const pnlUsd = (pnlPct / 100) * trade.betSize;
        await executeClose(trade, closeReason, currentPrice, pnlPct, pnlUsd);
      }
    } catch (err) {
      priceFetchFails++;
    }
  }

  // Track consecutive CLOB failures
  if (priceFetchOk === 0 && priceFetchFails > 0) {
    consecutiveClobFailures++;
    if (consecutiveClobFailures >= 3) {
      console.warn(`[settlement] WARNING: CLOB API unreachable for ${consecutiveClobFailures} consecutive cycles (${priceFetchFails} failed price fetches)`);
      logAuditEvent("CLOB_UNREACHABLE", { consecutiveFailures: consecutiveClobFailures, failedFetches: priceFetchFails });
      broadcastTradeEvent("CLOB_UNREACHABLE", { consecutiveFailures: consecutiveClobFailures });
    }
  } else {
    consecutiveClobFailures = 0;
  }
}

/**
 * Start the settlement monitor loop.
 */
export function startSettlementMonitor() {
  if (monitorTimer) return;
  console.log(`[settlement] Monitor started (TP: +${getConfigValue("take_profit_pct")}%, SL: ${getConfigValue("stop_loss_pct")}%, trail: ${getConfigValue("trailing_stop_pct")}%, maxHold: ${getConfigValue("max_hold_hours")}h)`);
  monitorTimer = setInterval(checkOpenTrades, CHECK_INTERVAL_MS);
  // Run initial check after 10s to let scanner warm up
  setTimeout(checkOpenTrades, 10_000);
}

/**
 * Stop the settlement monitor.
 */
export function stopSettlementMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

/**
 * Get monitor status for health checks.
 */
export function getMonitorStatus() {
  return {
    openTrades: openTrades.size,
    trades: Array.from(openTrades.values()).map(t => ({
      signalId: t.signalId,
      marketId: t.marketId,
      side: t.side,
      entryPrice: t.entryPrice,
      highestPrice: t.highestPrice,
      breakevenActivated: t.breakevenActivated,
      dryRun: t.dryRun,
      executionId: t.executionId,
      ageMinutes: Math.round((Date.now() - t.openedAt) / 60_000)
    })),
    takeProfitPct: getConfigValue("take_profit_pct"),
    stopLossPct: getConfigValue("stop_loss_pct"),
    trailingStopPct: getConfigValue("trailing_stop_pct"),
    breakevenTriggerPct: getConfigValue("breakeven_trigger_pct"),
    maxHoldHours: getConfigValue("max_hold_hours"),
    running: !!monitorTimer
  };
}
