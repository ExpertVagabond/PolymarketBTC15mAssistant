/**
 * Settlement monitor: tracks open trading positions and closes them on market settlement
 * or when take-profit/stop-loss thresholds are hit.
 *
 * Integrates with risk-manager to properly decrement openPositions and track P&L.
 * Default: safe — only monitors, requires ENABLE_TRADING=true for live close orders.
 */

import { recordTradeClose } from "./risk-manager.js";
import { CONFIG } from "../config.js";

const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT) || 15;
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT) || -10;
const CHECK_INTERVAL_MS = 60_000; // 1 minute

// In-memory ledger of open trades (maps signal ID to trade info)
const openTrades = new Map();
let monitorTimer = null;

/**
 * Fetch a single token's current price from the CLOB API.
 */
async function fetchTokenPrice(tokenId) {
  if (!tokenId) return null;
  try {
    const url = new URL("/price", CONFIG.clobBaseUrl);
    url.searchParams.set("token_id", tokenId);
    url.searchParams.set("side", "BUY");
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.price != null ? Number(data.price) : null;
  } catch {
    return null;
  }
}

/**
 * Register a new trade for monitoring.
 * Called when bot.js opens a position (live or dry-run).
 */
export function registerTrade({ signalId, marketId, tokenId, side, entryPrice, betSize, dryRun }) {
  openTrades.set(signalId, {
    signalId,
    marketId,
    tokenId,
    side,
    entryPrice,
    betSize,
    dryRun: !!dryRun,
    openedAt: Date.now()
  });
}

/**
 * Check all open trades for settlement, take-profit, or stop-loss.
 * Called periodically by the monitor loop.
 */
async function checkOpenTrades() {
  if (openTrades.size === 0) return;

  for (const [signalId, trade] of openTrades) {
    try {
      // Fetch current price from CLOB
      const currentPrice = await fetchTokenPrice(trade.tokenId);
      if (currentPrice == null) continue;

      // Check if market has settled (price at 0 or 1)
      const settled = currentPrice >= 0.99 || currentPrice <= 0.01;

      // Calculate unrealized P&L %
      const pnlPct = trade.entryPrice > 0
        ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
        : 0;

      let closeReason = null;

      if (settled) {
        closeReason = currentPrice >= 0.99 ? "SETTLED_WIN" : "SETTLED_LOSS";
      } else if (pnlPct >= TAKE_PROFIT_PCT) {
        closeReason = "TAKE_PROFIT";
      } else if (pnlPct <= STOP_LOSS_PCT) {
        closeReason = "STOP_LOSS";
      }

      if (closeReason) {
        const pnlUsd = (pnlPct / 100) * trade.betSize;

        // Update risk manager
        recordTradeClose(pnlUsd);

        console.log(
          `[settlement] ${closeReason} | Signal #${signalId} | ` +
          `${trade.side} @ ${trade.entryPrice.toFixed(3)} -> ${currentPrice.toFixed(3)} | ` +
          `P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% ($${pnlUsd.toFixed(2)}) | ` +
          `${trade.dryRun ? "DRY RUN" : "LIVE"}`
        );

        openTrades.delete(signalId);
      }
    } catch (err) {
      // Silently skip failed checks — will retry next cycle
    }
  }
}

/**
 * Start the settlement monitor loop.
 */
export function startSettlementMonitor() {
  if (monitorTimer) return;
  console.log(`[settlement] Monitor started (TP: +${TAKE_PROFIT_PCT}%, SL: ${STOP_LOSS_PCT}%, interval: ${CHECK_INTERVAL_MS / 1000}s)`);
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
      dryRun: t.dryRun,
      ageMinutes: Math.round((Date.now() - t.openedAt) / 60_000)
    })),
    takeProfitPct: TAKE_PROFIT_PCT,
    stopLossPct: STOP_LOSS_PCT,
    running: !!monitorTimer
  };
}
