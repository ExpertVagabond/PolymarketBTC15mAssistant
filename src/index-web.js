#!/usr/bin/env node
/**
 * Web dashboard entry point.
 * Usage: node src/index-web.js
 * Env: WEB_PORT=3000
 */

import { startWebServer } from "./web/server.js";
import { closeDb } from "./subscribers/db.js";

const app = await startWebServer();

// Graceful shutdown
let shutdownCalled = false;
const shutdown = async (signal) => {
  if (shutdownCalled) return;
  shutdownCalled = true;
  console.log(`\n[shutdown] ${signal} received`);
  try { await app.close(); } catch {}
  try { closeDb(); } catch {}
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
