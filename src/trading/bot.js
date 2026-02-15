/**
 * Auto-trading bot: only trades on ENTER + STRONG/GOOD signals.
 * DEFAULT: DRY RUN ONLY. Requires ENABLE_TRADING=true AND TRADING_DRY_RUN=false for live.
 */

import { createPoller } from "../core/poller.js";
import { createWindowTracker } from "../backtest/window-tracker.js";
import { checkAndAlert } from "../alerts/manager.js"; // legacy Telegram/Discord
import { dispatchWebhooks, dispatchEmailAlerts } from "../notifications/dispatch.js";
import { canTrade, getBetSize, recordTradeOpen, recordTradeClose, getRiskStatus, syncOpenPositions } from "./risk-manager.js";
import { logDryRunTrade } from "./dry-run-logger.js";
import { isTradingConfigured } from "./clob-auth.js";
import { placeMarketOrder, placeSellOrder, checkLiquidity } from "./clob-orders.js";
import { registerTrade, startSettlementMonitor } from "./settlement-monitor.js";
import { logExecution, getOpenCount } from "./execution-log.js";
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

  // Sync risk manager open positions from DB on startup
  try {
    const dbOpenCount = getOpenCount();
    if (dbOpenCount > 0) {
      syncOpenPositions(dbOpenCount);
      console.log(`[bot] Synced ${dbOpenCount} open positions from DB`);
    }
  } catch { /* first run, table may not exist yet */ }

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
    const confidence = state.confidence?.score ?? null;
    const question = state.poly?.market?.question ?? null;
    const category = state.poly?.market?.category ?? null;

    console.log(`[${new Date().toISOString()}] SIGNAL: ${signal} | ${rec.strength} | Edge: ${((edge ?? 0) * 100).toFixed(1)}% | Bet: $${betSize.toFixed(2)}`);

    if (!ENABLED || DRY_RUN) {
      logDryRunTrade(state, betSize);
      const execId = logExecution({
        signalId: String(Date.now()), marketId: state.marketId || "", tokenId: tokenId || "",
        question, category, side: rec.side, strength: rec.strength,
        amount: betSize, entryPrice, dryRun: true, edge, confidence
      });
      registerTrade({ signalId: Date.now(), marketId: state.marketId || "", tokenId: tokenId || "", side: rec.side, entryPrice, betSize, dryRun: true, executionId: execId });
      recordTradeOpen();
      console.log(`  -> DRY RUN logged (exec #${execId}) + registered for settlement monitoring`);
      return;
    }

    // LIVE TRADE
    if (!tokenId) {
      console.log(`  -> ERROR: No token ID for ${rec.side}`);
      logExecution({
        signalId: String(Date.now()), marketId: state.marketId || "",
        side: rec.side, strength: rec.strength, amount: betSize,
        entryPrice, dryRun: false, status: "failed", error: "no_token_id"
      });
      return;
    }

    // Pre-trade liquidity check
    let liquidityResult = null;
    try {
      liquidityResult = await checkLiquidity(tokenId, "BUY", betSize);
      if (!liquidityResult.ok) {
        console.log(`  -> BLOCKED: ${liquidityResult.reason} | Available: $${liquidityResult.availableLiquidity?.toFixed(2)}`);
        logExecution({
          signalId: String(Date.now()), marketId: state.marketId || "", tokenId,
          question, category, side: rec.side, strength: rec.strength,
          amount: betSize, entryPrice, dryRun: false, status: "failed",
          edge, confidence, liquidityCheck: liquidityResult, error: liquidityResult.reason
        });
        return;
      }
    } catch (err) {
      console.log(`  -> Liquidity check failed (proceeding): ${err.message}`);
    }

    try {
      const result = await placeMarketOrder({ tokenId, side: rec.side, amount: betSize });

      const execId = logExecution({
        signalId: String(Date.now()), marketId: state.marketId || "", tokenId,
        question, category, side: rec.side, strength: rec.strength,
        amount: betSize, entryPrice, fillPrice: result.orderPrice,
        dryRun: false, status: result.ok ? "open" : "failed",
        orderId: result.data?.orderID || result.data?.id || null,
        edge, confidence, liquidityCheck: liquidityResult,
        error: result.ok ? null : JSON.stringify(result.data)
      });

      if (result.ok) {
        registerTrade({ signalId: Date.now(), marketId: state.marketId || "", tokenId, side: rec.side, entryPrice: result.orderPrice, betSize, dryRun: false, executionId: execId });
        recordTradeOpen();
        console.log(`  -> ORDER PLACED (exec #${execId}): ${JSON.stringify(result.data)}`);
      } else {
        console.log(`  -> ORDER REJECTED (exec #${execId}): ${result.status} ${JSON.stringify(result.data)}`);
      }
    } catch (err) {
      logExecution({
        signalId: String(Date.now()), marketId: state.marketId || "", tokenId,
        question, category, side: rec.side, strength: rec.strength,
        amount: betSize, entryPrice, dryRun: false, status: "failed",
        edge, confidence, error: err.message
      });
      console.log(`  -> ORDER FAILED: ${err.message}`);
    }
  });
}
