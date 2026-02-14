/**
 * Fastify HTTP + WebSocket server for the web dashboard.
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebSocket from "@fastify/websocket";
import { addClient, broadcastState, getClientCount } from "./ws-handler.js";
import { createPoller } from "../core/poller.js";
import { createWindowTracker } from "../backtest/window-tracker.js";
import { getState, getHistory } from "../core/state.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT) || 3000;

export async function startWebServer() {
  applyGlobalProxyFromEnv();

  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "static"),
    prefix: "/"
  });

  await app.register(fastifyWebSocket);

  app.get("/ws", { websocket: true }, (socket) => {
    addClient(socket);
    // send current state immediately on connect
    const current = getState();
    if (current) {
      try { broadcastState(current); } catch { /* ignore */ }
    }
  });

  // REST API endpoints
  app.get("/api/state", async () => {
    return getState() ?? { error: "no_data" };
  });

  app.get("/api/history", async (req) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    return getHistory(limit).map((h) => ({
      time: h.timestamp,
      signal: h.signal,
      model_up: h.timeAware?.adjustedUp,
      model_down: h.timeAware?.adjustedDown,
      btc: h.prices?.spot,
      rsi: h.indicators?.rsi
    }));
  });

  // start poller in background
  const poller = createPoller();
  const windowTracker = createWindowTracker();

  poller.start((state, err) => {
    if (!err && state) {
      windowTracker.onTick(state);
      broadcastState(state);
    }
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Web dashboard: http://localhost:${PORT}`);
  console.log(`WebSocket:     ws://localhost:${PORT}/ws`);

  return app;
}
