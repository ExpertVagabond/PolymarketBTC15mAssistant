/**
 * Scanner-trader bridge: subscribes to orchestrator signal:enter events
 * and routes them through the trading pipeline (risk checks, execution, settlement).
 *
 * This replaces the single-market poller approach in bot.js with multi-market support.
 */

import { canTrade, getBetSize, recordTradeOpen, getRiskStatus } from "./risk-manager.js";
import { canOpenNewTrades, getBotControlState } from "./bot-control.js";
import { logDryRunTrade } from "./dry-run-logger.js";
import { isTradingConfigured } from "./clob-auth.js";
import { placeMarketOrder, checkLiquidity, pollOrderFill } from "./clob-orders.js";
import { registerTrade, startSettlementMonitor } from "./settlement-monitor.js";
import { logExecution, failExecution } from "./execution-log.js";
import { checkBalance, invalidateBalanceCache } from "./wallet.js";
import { logAuditEvent } from "./audit-log.js";

const ENABLED = (process.env.ENABLE_TRADING || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.TRADING_DRY_RUN || "true").toLowerCase() !== "false";
const MIN_STRENGTH = new Set(["STRONG", "GOOD"]);

let signalCount = 0;
let tradeCount = 0;

/**
 * Attach trading pipeline to an orchestrator instance.
 * Call once during server startup when orchestrator is available.
 */
export function attachScannerTrader(orchestrator) {
  if (!orchestrator) return;

  console.log(`[scanner-trader] Attached (mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}, enabled: ${ENABLED})`);

  startSettlementMonitor();

  orchestrator.on("signal:enter", async (tick) => {
    signalCount++;

    try {
      await processSignal(tick);
    } catch (err) {
      console.warn(`[scanner-trader] Error processing signal for ${tick.marketId || "unknown"}: ${err.message}`);
    }
  });
}

/**
 * Process a single signal from the scanner.
 */
async function processSignal(tick) {
  const rec = tick.rec;
  if (!rec || rec.action !== "ENTER") return;
  if (!MIN_STRENGTH.has(rec.strength)) return;

  // Check bot control
  if (!canOpenNewTrades()) return;

  const category = tick.market?.category || tick.category || null;

  // Check risk limits (with category for concentration check)
  const riskCheck = canTrade(category);
  if (!riskCheck.allowed) {
    logAuditEvent("RISK_BLOCKED", { marketId: tick.marketId, side: rec.side, category, detail: riskCheck.reason });
    console.log(`[scanner-trader] BLOCKED: ${riskCheck.reason} | ${tick.signal} on ${tick.market?.slug || tick.marketId}`);
    return;
  }

  const edge = rec.side === "UP" ? tick.edge?.edgeUp : tick.edge?.edgeDown;
  const betSize = getBetSize(edge ?? 0.1);
  const tokenId = rec.side === "UP"
    ? (tick.poly?.tokens?.upTokenId || tick.tokens?.upTokenId)
    : (tick.poly?.tokens?.downTokenId || tick.tokens?.downTokenId);
  const entryPrice = rec.side === "UP"
    ? (tick.prices?.up ?? 0.5)
    : (tick.prices?.down ?? 0.5);
  const confidence = tick.confidence ?? null;
  const question = tick.market?.question || tick.question || null;
  const marketId = tick.marketId || tick.market?.slug || "";

  console.log(`[scanner-trader] SIGNAL: ${tick.signal} | ${rec.strength} | ${question?.slice(0, 50)} | Edge: ${((edge ?? 0) * 100).toFixed(1)}% | Bet: $${betSize.toFixed(2)}`);

  // Dry run path
  if (!ENABLED || DRY_RUN) {
    logDryRunTrade(tick, betSize);
    const execId = logExecution({
      signalId: String(Date.now()), marketId, tokenId: tokenId || "",
      question, category, side: rec.side, strength: rec.strength,
      amount: betSize, entryPrice, dryRun: true, edge, confidence
    });
    registerTrade({ signalId: Date.now(), marketId, tokenId: tokenId || "", side: rec.side, entryPrice, betSize, dryRun: true, executionId: execId });
    recordTradeOpen();
    tradeCount++;
    logAuditEvent("POSITION_OPENED", { executionId: execId, marketId, tokenId, side: rec.side, category, amount: betSize, price: entryPrice, dryRun: true });
    console.log(`  -> DRY RUN logged (exec #${execId})`);
    return;
  }

  // Live trade path
  if (!tokenId) {
    console.log(`  -> ERROR: No token ID for ${rec.side} on ${marketId}`);
    logExecution({
      signalId: String(Date.now()), marketId,
      side: rec.side, strength: rec.strength, amount: betSize,
      entryPrice, dryRun: false, status: "failed", error: "no_token_id"
    });
    return;
  }

  // Pre-trade balance check
  try {
    const balCheck = await checkBalance(betSize);
    if (!balCheck.ok) {
      logAuditEvent("RISK_BLOCKED", { marketId, side: rec.side, amount: betSize, detail: balCheck.reason });
      console.log(`  -> BLOCKED: ${balCheck.reason} | Balance: $${(balCheck.balance || 0).toFixed(2)}`);
      return;
    }
  } catch (err) {
    console.log(`  -> Balance check failed (proceeding): ${err.message}`);
  }

  // Pre-trade liquidity check
  let liquidityResult = null;
  try {
    liquidityResult = await checkLiquidity(tokenId, "BUY", betSize);
    if (!liquidityResult.ok) {
      console.log(`  -> BLOCKED: ${liquidityResult.reason} | Available: $${liquidityResult.availableLiquidity?.toFixed(2)}`);
      logExecution({
        signalId: String(Date.now()), marketId, tokenId,
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
      signalId: String(Date.now()), marketId, tokenId,
      question, category, side: rec.side, strength: rec.strength,
      amount: betSize, entryPrice, fillPrice: result.orderPrice,
      dryRun: false, status: result.ok ? "open" : "failed",
      orderId: result.data?.orderID || result.data?.id || null,
      edge, confidence, liquidityCheck: liquidityResult,
      error: result.ok ? null : JSON.stringify(result.data)
    });

    if (result.ok) {
      const orderId = result.data?.orderID || result.data?.id || null;
      invalidateBalanceCache();
      logAuditEvent("ORDER_PLACED", { executionId: execId, marketId, tokenId, side: rec.side, category, amount: betSize, price: result.orderPrice, dryRun: false, detail: result.data });
      console.log(`  -> ORDER PLACED (exec #${execId}): ${JSON.stringify(result.data)}`);

      // Poll for fill confirmation (non-blocking — runs in background)
      if (orderId) {
        pollOrderFill(orderId, { pollIntervalMs: 5000, maxPollMs: 60000 }).then(fill => {
          if (fill.fillStatus === "filled") {
            const fillPrice = fill.avgFillPrice || result.orderPrice;
            registerTrade({ signalId: Date.now(), marketId, tokenId, side: rec.side, entryPrice: fillPrice, betSize: fill.filledSize || betSize, dryRun: false, executionId: execId });
            recordTradeOpen();
            tradeCount++;
            logAuditEvent("ORDER_FILLED", { executionId: execId, marketId, tokenId, side: rec.side, amount: fill.filledSize || betSize, price: fillPrice, detail: fill });
            console.log(`  -> ORDER FILLED (exec #${execId}): ${fill.filledSize || betSize} @ ${fillPrice.toFixed(4)}`);
          } else if (fill.fillStatus === "partial") {
            registerTrade({ signalId: Date.now(), marketId, tokenId, side: rec.side, entryPrice: fill.avgFillPrice || result.orderPrice, betSize: fill.filledSize, dryRun: false, executionId: execId });
            recordTradeOpen();
            tradeCount++;
            logAuditEvent("ORDER_PARTIAL_FILL", { executionId: execId, marketId, amount: fill.filledSize, detail: fill });
            console.log(`  -> PARTIAL FILL (exec #${execId}): ${fill.filledSize}/${betSize}`);
          } else {
            // Rejected or timeout — mark execution as failed
            failExecution(execId, `fill_${fill.fillStatus}`);
            logAuditEvent("ORDER_FILL_FAILED", { executionId: execId, marketId, detail: fill });
            console.log(`  -> FILL ${fill.fillStatus.toUpperCase()} (exec #${execId})`);
          }
        }).catch(err => {
          // Fill polling error — position may or may not exist
          logAuditEvent("ORDER_FILL_ERROR", { executionId: execId, detail: err.message });
          console.warn(`  -> Fill poll error (exec #${execId}): ${err.message}`);
          // Optimistic: register trade anyway so settlement monitor tracks it
          registerTrade({ signalId: Date.now(), marketId, tokenId, side: rec.side, entryPrice: result.orderPrice, betSize, dryRun: false, executionId: execId });
          recordTradeOpen();
          tradeCount++;
        });
      } else {
        // No orderId returned — can't poll, register optimistically
        registerTrade({ signalId: Date.now(), marketId, tokenId, side: rec.side, entryPrice: result.orderPrice, betSize, dryRun: false, executionId: execId });
        recordTradeOpen();
        tradeCount++;
      }
    } else {
      logAuditEvent("ORDER_REJECTED", { executionId: execId, marketId, tokenId, side: rec.side, amount: betSize, dryRun: false, detail: result.data });
      console.log(`  -> ORDER REJECTED (exec #${execId}): ${result.status} ${JSON.stringify(result.data)}`);
    }
  } catch (err) {
    logExecution({
      signalId: String(Date.now()), marketId, tokenId,
      question, category, side: rec.side, strength: rec.strength,
      amount: betSize, entryPrice, dryRun: false, status: "failed",
      edge, confidence, error: err.message
    });
    console.log(`  -> ORDER FAILED: ${err.message}`);
  }
}

/**
 * Get scanner-trader stats for health checks.
 */
export function getScannerTraderStats() {
  return {
    signalsReceived: signalCount,
    tradesExecuted: tradeCount,
    enabled: ENABLED,
    dryRun: DRY_RUN,
    apiConfigured: isTradingConfigured(),
    risk: getRiskStatus(),
    botControl: getBotControlState()
  };
}
