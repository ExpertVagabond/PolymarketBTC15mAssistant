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
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

applyGlobalProxyFromEnv();

const orchestrator = createOrchestrator();

// Start web server with orchestrator (auto-attaches scanner-trader)
const app = await startWebServer({ orchestrator });

// Start the scanner
await orchestrator.start();

console.log("[index-scanner-web] Scanner + Web + Trading pipeline running");
