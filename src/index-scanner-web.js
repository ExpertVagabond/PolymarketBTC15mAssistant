#!/usr/bin/env node
/**
 * Combined entry point: multi-market scanner + web dashboard + auto-trading.
 * Usage: node src/index-scanner-web.js
 *
 * This starts the scanner orchestrator, the web server, and wires
 * scanner signals into the trading pipeline automatically.
 */

import { createOrchestrator } from "./scanner/orchestrator.js";
import { startWebServer } from "./web/server.js";
import { stopSettlementMonitor } from "./trading/settlement-monitor.js";
import { broadcastTradeEvent } from "./web/ws-handler.js";
import { closeDb } from "./subscribers/db.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

applyGlobalProxyFromEnv();

const orchestrator = createOrchestrator();

// Start web server with orchestrator (auto-attaches scanner-trader)
const app = await startWebServer({ orchestrator });

// Start the scanner
await orchestrator.start();

console.log("[index-scanner-web] Scanner + Web + Trading pipeline running");

// Graceful shutdown
let shutdownCalled = false;
const shutdown = async (signal) => {
  if (shutdownCalled) return;
  shutdownCalled = true;
  console.log(`\n[shutdown] ${signal} received — shutting down gracefully...`);

  try { broadcastTradeEvent("SHUTDOWN", { reason: signal }); } catch {}
  orchestrator.stop();
  stopSettlementMonitor();
  try { await app.close(); } catch {}
  try { closeDb(); } catch {}

  console.log("[shutdown] Complete");
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
