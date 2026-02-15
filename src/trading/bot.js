/**
 * Auto-trading bot: only trades on ENTER + STRONG/GOOD signals.
 * DEFAULT: DRY RUN ONLY. Requires ENABLE_TRADING=true AND TRADING_DRY_RUN=false for live.
 */

import { createPoller } from "../core/poller.js";
import { createWindowTracker } from "../backtest/window-tracker.js";
import { checkAndAlert } from "../alerts/manager.js"; // legacy Telegram/Discord
import { dispatchWebhooks, dispatchEmailAlerts } from "../notifications/dispatch.js";
import { canTrade, getBetSize, recordTradeOpen, getRiskStatus } from "./risk-manager.js";
import { logDryRunTrade } from "./dry-run-logger.js";
import { isTradingConfigured } from "./clob-auth.js";
import { placeMarketOrder } from "./clob-orders.js";
import { registerTrade, startSettlementMonitor } from "./settlement-monitor.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";

const ENABLED = (process.env.ENABLE_TRADING || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.TRADING_DRY_RUN || "true").toLowerCase() !== "false";

export async function startTradingBot() {
  applyGlobalProxyFromEnv();

  console.log("=== Polymarket BTC 15m Trading Bot ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Trading enabled: ${ENABLED}`);
  console.log(`API configured: ${isTradingConfigured()}`);
  console.log("");

  if (!ENABLED) {
    console.log("Trading is disabled. Set ENABLE_TRADING=true to enable.");
    console.log("Running in observation mode (signals only)...\n");
  }

  if (!DRY_RUN && !isTradingConfigured()) {
    console.log("ERROR: Live trading requires API credentials.");
    console.log("Set: POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE, POLYMARKET_PRIVATE_KEY");
    process.exit(1);
  }

  const poller = createPoller();
  const windowTracker = createWindowTracker();
  let tickCount = 0;

  // Start settlement monitor to track and close positions
  startSettlementMonitor();

  await poller.start(async (state, err) => {
    if (err) {
      console.log(`[${new Date().toISOString()}] Error: ${err.message}`);
      return;
    }

    tickCount++;
    windowTracker.onTick(state);

    // fire alerts if configured (legacy Telegram/Discord + modern webhook/email)
    await checkAndAlert(state);
    const { rec, signal } = state;
    if (rec.action === "ENTER") {
      dispatchWebhooks(state).catch(() => {});
      dispatchEmailAlerts(state).catch(() => {});
    }

    // only trade on ENTER signals with STRONG or GOOD strength
    if (rec.action !== "ENTER" || (rec.strength !== "STRONG" && rec.strength !== "GOOD")) {
      if (tickCount % 60 === 0) {
        const risk = getRiskStatus();
        console.log(`[${new Date().toISOString()}] Tick #${tickCount} | Signal: ${signal} | Daily P&L: $${risk.dailyPnl.toFixed(2)} | Positions: ${risk.openPositions}/${risk.maxPositions}`);
      }
      return;
    }

    // check risk limits
    const riskCheck = canTrade();
    if (!riskCheck.allowed) {
      console.log(`[${new Date().toISOString()}] BLOCKED: ${riskCheck.reason} | Signal was: ${signal}`);
      return;
    }

    const edge = rec.side === "UP" ? state.edge?.edgeUp : state.edge?.edgeDown;
    const betSize = getBetSize(edge ?? 0.1);
    const tokenId = rec.side === "UP" ? state.poly?.tokens?.upTokenId : state.poly?.tokens?.downTokenId;
    const entryPrice = rec.side === "UP" ? (state.prices?.up ?? 0.5) : (state.prices?.down ?? 0.5);

    console.log(`[${new Date().toISOString()}] SIGNAL: ${signal} | ${rec.strength} | Edge: ${((edge ?? 0) * 100).toFixed(1)}% | Bet: $${betSize.toFixed(2)}`);

    if (!ENABLED || DRY_RUN) {
      logDryRunTrade(state, betSize);
      registerTrade({ signalId: Date.now(), marketId: state.marketId || "", tokenId: tokenId || "", side: rec.side, entryPrice, betSize, dryRun: true });
      recordTradeOpen();
      console.log(`  -> DRY RUN logged + registered for settlement monitoring`);
      return;
    }

    // LIVE TRADE
    if (!tokenId) {
      console.log(`  -> ERROR: No token ID for ${rec.side}`);
      return;
    }

    try {
      const result = await placeMarketOrder({ tokenId, side: rec.side, amount: betSize });
      registerTrade({ signalId: Date.now(), marketId: state.marketId || "", tokenId, side: rec.side, entryPrice, betSize, dryRun: false });
      recordTradeOpen();
      console.log(`  -> ORDER PLACED: ${JSON.stringify(result.data)}`);
    } catch (err) {
      console.log(`  -> ORDER FAILED: ${err.message}`);
    }
  });
}
