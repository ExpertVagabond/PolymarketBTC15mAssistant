/**
 * Unified server: multi-market scanner + web dashboard + Telegram + Discord.
 * Single process, event-driven. Scanner emits signals → bots + web broadcast.
 *
 * Usage: node src/server.js
 */

import { createOrchestrator } from "./scanner/orchestrator.js";
import { startWebServer } from "./web/server.js";
import { startTelegramBot } from "./bots/telegram/bot.js";
import { broadcastSignal as tgBroadcast, flushDelayed as tgFlush } from "./bots/telegram/broadcaster.js";
import { startDiscordBot } from "./bots/discord/bot.js";
import { broadcastSignal as dcBroadcast, flushDelayed as dcFlush } from "./bots/discord/broadcaster.js";
import { broadcastState } from "./web/ws-handler.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { getDb, closeDb } from "./subscribers/db.js";
import { initSignalHistory, logSignal, getUnsettledSignals, recordOutcome, getSignalStats, voidStaleSignals, purgeOldSignals, getRecentlySettled } from "./signals/history.js";
import { startWeightRefresh, stopWeightRefresh, getAllWeights } from "./engines/weights.js";
import { fetchClobPrice } from "./data/polymarket.js";
import { sleep } from "./utils.js";
import { initPortfolio, openPosition, updatePrices, checkSettlements } from "./portfolio/tracker.js";

async function main() {
  applyGlobalProxyFromEnv();

  console.log("=== PolySignal ===");
  console.log(`Starting at ${new Date().toISOString()}\n`);

  // Initialize databases + weight learning
  getDb();
  initSignalHistory();
  initPortfolio();
  startWeightRefresh();
  console.log("[db] Subscriber + signal history + portfolio databases ready");

  // Create scanner orchestrator
  const orchestrator = createOrchestrator();

  // Wire up signal events — log + broadcast
  orchestrator.on("signal:enter", async (tick) => {
    // Log to signal history
    try {
      logSignal(tick);
    } catch (err) {
      console.error("[signals] Failed to log:", err.message);
    }

    // Open virtual portfolio position
    try { openPosition(tick); } catch { /* ignore */ }

    // Broadcast to Telegram
    tgBroadcast(tick).catch((err) => console.error("[broadcast] Telegram error:", err.message));
    // Broadcast to Discord
    dcBroadcast(tick).catch((err) => console.error("[broadcast] Discord error:", err.message));
  });

  orchestrator.on("scanner:ready", ({ marketCount }) => {
    console.log(`[scanner] Ready — tracking ${marketCount} markets`);
  });

  orchestrator.on("cycle:complete", ({ marketsPolled, signals }) => {
    if (signals > 0) {
      console.log(`[scanner] Cycle: ${marketsPolled} markets polled, ${signals} active signals`);
    }
  });

  orchestrator.on("market:added", ({ question, category }) => {
    console.log(`[scanner] + ${category}: ${question?.slice(0, 60)}`);
  });

  orchestrator.on("market:removed", ({ question }) => {
    console.log(`[scanner] - removed: ${question?.slice(0, 60)}`);
  });

  orchestrator.on("error", ({ marketId, error }) => {
    console.error(`[scanner] Error on ${marketId}: ${error}`);
  });

  // Start web server
  const app = await startWebServer({ orchestrator });

  // Start Telegram bot
  const tgBot = startTelegramBot({ orchestrator });

  // Start Discord bot
  const dcBot = await startDiscordBot({ orchestrator }).catch((err) => {
    console.error("[discord] Failed to start:", err.message);
    return null;
  });

  // Start scanner
  orchestrator.start().catch((err) => {
    console.error("[scanner] Fatal error:", err.message);
  });

  // Flush delayed messages every 30 seconds
  setInterval(() => {
    tgFlush().catch(() => {});
    dcFlush().catch(() => {});
  }, 30_000);

  // Check signal outcomes every 2 minutes
  setInterval(async () => {
    try {
      const unsettled = getUnsettledSignals();
      let settledCount = 0;

      for (const sig of unsettled) {
        const state = orchestrator.getState();
        const entry = state[sig.market_id];
        if (!entry?.lastTick) continue;

        const tick = entry.lastTick;
        const market = tick.market || {};
        const settlementMin = tick.settlementLeftMin ?? market.settlementLeftMin;

        // Check 1: Market explicitly closed/resolved
        const isClosed = market.closed === true || market.active === false;

        // Check 2: Settlement time passed
        const isPastSettlement = settlementMin != null && settlementMin <= 0;

        if (!isClosed && !isPastSettlement) continue;

        // Determine outcome from final prices
        const yesPrice = tick.prices?.up ?? market.up;
        const noPrice = tick.prices?.down ?? market.down;

        if (yesPrice == null || noPrice == null) continue;

        // Settled: price near 0 or 1 (or market explicitly closed)
        const priceSettled = yesPrice > 0.9 || yesPrice < 0.1 || noPrice > 0.9 || noPrice < 0.1;
        if (!isClosed && !priceSettled) continue;

        const yesWon = yesPrice > 0.5;
        const sigBoughtYes = sig.side === "UP";
        const won = (sigBoughtYes && yesWon) || (!sigBoughtYes && !yesWon);

        const entryPrice = sigBoughtYes ? (sig.market_yes || 0.5) : (sig.market_no || 0.5);
        const pnlPct = won ? ((1.0 - entryPrice) / entryPrice) : -1.0;

        recordOutcome({
          id: sig.id,
          outcome: won ? "WIN" : "LOSS",
          outcomeYes: yesPrice,
          outcomeNo: noPrice,
          pnlPct
        });

        settledCount++;
        console.log(`[signals] ${won ? "WIN" : "LOSS"}: ${sig.side} on ${sig.market_id.slice(0, 8)}... (edge: ${((sig.edge || 0) * 100).toFixed(1)}%, pnl: ${(pnlPct * 100).toFixed(1)}%)`);
      }

      // Void stale signals (>24h past expected settlement with no resolution)
      const voided = voidStaleSignals();
      if (voided > 0) console.log(`[signals] Voided ${voided} stale signal(s)`);

      // Push settlement notifications to bots
      if (settledCount > 0) {
        const recent = getRecentlySettled(3);
        for (const s of recent) {
          const msg = `${s.outcome === "WIN" ? "WIN" : "LOSS"}: ${s.side === "UP" ? "YES" : "NO"} on ${(s.question || "").slice(0, 50)} | P&L: ${s.pnl_pct != null ? (s.pnl_pct >= 0 ? "+" : "") + (s.pnl_pct * 100).toFixed(1) + "%" : "-"}`;
          tgBroadcast({ signal: "SETTLED", question: s.question, category: s.category, settlementMsg: msg }).catch(() => {});
          dcBroadcast({ signal: "SETTLED", question: s.question, category: s.category, settlementMsg: msg }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[signals] Outcome check error:", err.message);
    }
  }, 120_000);

  // Data retention: purge old settled signals daily (check every hour)
  setInterval(() => {
    try {
      const purged = purgeOldSignals(90);
      if (purged > 0) console.log(`[retention] Purged ${purged} signals older than 90 days`);
    } catch (err) {
      console.error("[retention] Purge error:", err.message);
    }
  }, 3600_000);

  // Broadcast scanner state to WebSocket clients periodically
  setInterval(() => {
    const state = orchestrator.getState();
    const signals = orchestrator.getActiveSignals();
    const stats = orchestrator.getStats();
    broadcastState({ scanner: { state, signals, stats } });

    // Update portfolio prices and check settlements
    try {
      updatePrices(state);
      checkSettlements(state);
    } catch { /* ignore */ }
  }, 10_000);

  console.log("\n[server] All systems online");
  console.log("[polysignal] Scanner + Web + Telegram + Discord running");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[server] Shutting down...");
    orchestrator.stop();
    stopWeightRefresh();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
