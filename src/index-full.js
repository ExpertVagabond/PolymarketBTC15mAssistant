#!/usr/bin/env node
/**
 * Full integration: alerts + trading + web dashboard + backtest tracking.
 * Usage: node src/index-full.js
 * Env: WEB_PORT=3000, ENABLE_ALERTS=false, ENABLE_TRADING=false, TRADING_DRY_RUN=true
 */

import { createPoller } from "./core/poller.js";
import { createWindowTracker } from "./backtest/window-tracker.js";
import { checkAndAlert, isAlertsEnabled } from "./alerts/manager.js";
import { canTrade, getBetSize, recordTradeOpen, getRiskStatus } from "./trading/risk-manager.js";
import { logDryRunTrade } from "./trading/dry-run-logger.js";
import { isTradingConfigured } from "./trading/clob-auth.js";
import { placeMarketOrder } from "./trading/clob-orders.js";
import { broadcastState } from "./web/ws-handler.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebSocket from "@fastify/websocket";
import { addClient } from "./web/ws-handler.js";
import { getState, getHistory } from "./core/state.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT) || 3000;
const TRADING_ENABLED = (process.env.ENABLE_TRADING || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.TRADING_DRY_RUN || "true").toLowerCase() !== "false";

applyGlobalProxyFromEnv();

console.log("=== Polymarket BTC 15m — Full Mode ===");
console.log(`Web dashboard: http://localhost:${PORT}`);
console.log(`Alerts: ${isAlertsEnabled() ? "ON" : "OFF"}`);
console.log(`Trading: ${TRADING_ENABLED ? (DRY_RUN ? "DRY RUN" : "LIVE") : "OFF"}`);
console.log("");

// web server
const app = Fastify({ logger: false });
await app.register(fastifyStatic, { root: path.join(__dirname, "web/static"), prefix: "/" });
await app.register(fastifyWebSocket);
app.get("/ws", { websocket: true }, (socket) => {
  addClient(socket);
  const current = getState();
  if (current) broadcastState(current);
});
app.get("/api/state", async () => getState() ?? { error: "no_data" });
app.get("/api/history", async (req) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  return getHistory(limit).map((h) => ({ time: h.timestamp, signal: h.signal, btc: h.prices?.spot }));
});
await app.listen({ port: PORT, host: "0.0.0.0" });

// poller + all features
const poller = createPoller();
const windowTracker = createWindowTracker();
let tickCount = 0;

await poller.start(async (state, err) => {
  if (err) {
    console.log(`[${new Date().toISOString()}] Error: ${err.message}`);
    return;
  }

  tickCount++;
  windowTracker.onTick(state);
  broadcastState(state);
  await checkAndAlert(state);

  // trading logic
  if (TRADING_ENABLED && state.rec?.action === "ENTER" && (state.rec.strength === "STRONG" || state.rec.strength === "GOOD")) {
    const riskCheck = canTrade();
    if (riskCheck.allowed) {
      const edge = state.rec.side === "UP" ? state.edge?.edgeUp : state.edge?.edgeDown;
      const betSize = getBetSize(edge ?? 0.1);

      if (DRY_RUN) {
        logDryRunTrade(state, betSize);
        console.log(`[DRY] ${state.signal} | $${betSize.toFixed(2)}`);
      } else {
        const tokenId = state.rec.side === "UP" ? state.poly?.tokens?.upTokenId : state.poly?.tokens?.downTokenId;
        if (tokenId) {
          try {
            await placeMarketOrder({ tokenId, side: state.rec.side, amount: betSize });
            recordTradeOpen();
            console.log(`[LIVE] ${state.signal} | $${betSize.toFixed(2)}`);
          } catch (e) { console.log(`[ERR] Order failed: ${e.message}`); }
        }
      }
    }
  }

  if (tickCount % 60 === 0) {
    const risk = getRiskStatus();
    console.log(`[${new Date().toISOString()}] Tick #${tickCount} | ${state.signal} | P&L: $${risk.dailyPnl.toFixed(2)} | Clients: web connected`);
  }
});
