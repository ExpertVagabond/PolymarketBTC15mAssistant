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
import { sleep } from "./utils.js";

async function main() {
  applyGlobalProxyFromEnv();

  console.log("=== Polymarket Signal Bot ===");
  console.log(`Starting at ${new Date().toISOString()}\n`);

  // Initialize subscriber database
  getDb();
  console.log("[db] Subscriber database ready");

  // Create scanner orchestrator
  const orchestrator = createOrchestrator();

  // Wire up signal events
  orchestrator.on("signal:enter", async (tick) => {
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

  // Broadcast scanner state to WebSocket clients periodically
  setInterval(() => {
    const state = orchestrator.getState();
    const signals = orchestrator.getActiveSignals();
    const stats = orchestrator.getStats();
    broadcastState({ scanner: { state, signals, stats } });
  }, 10_000);

  console.log("\n[server] All systems online");
  console.log("[server] Scanner + Web + Telegram + Discord running");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[server] Shutting down...");
    orchestrator.stop();
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
