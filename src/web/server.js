/**
 * Fastify HTTP + WebSocket server for the web dashboard.
 * Supports: auth (magic link), Stripe webhooks, multi-market scanner, subscriptions.
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebSocket from "@fastify/websocket";
import { addClient, broadcastState, getClientCount } from "./ws-handler.js";
import { createPoller } from "../core/poller.js";
import { createWindowTracker } from "../backtest/window-tracker.js";
import { getState, getHistory } from "../core/state.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import { sendMagicLink, verifyMagicLink, verifySession, requireAuth, requireSubscription } from "./auth.js";
import { verifyWebhookEvent, handleWebhookEvent } from "../subscribers/stripe-webhook.js";
import { getByEmail, getStats as getSubStats } from "../subscribers/manager.js";
import { grantChannelAccess } from "../bots/telegram/access.js";
import { grantPremiumRole } from "../bots/discord/access.js";
import { linkTelegram, linkDiscord } from "../subscribers/manager.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT) || 3000;

/**
 * Start the web server.
 * @param {object} opts
 * @param {object} opts.orchestrator - Scanner orchestrator (optional, for multi-market mode)
 */
export async function startWebServer(opts = {}) {
  applyGlobalProxyFromEnv();

  const orchestrator = opts.orchestrator || null;
  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "static"),
    prefix: "/"
  });

  await app.register(fastifyWebSocket);

  /* ── WebSocket ── */

  app.get("/ws", { websocket: true }, (socket) => {
    addClient(socket);
    const current = getState();
    if (current) {
      try { broadcastState(current); } catch { /* ignore */ }
    }
  });

  /* ── Public API ── */

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

  /* ── Scanner API (if orchestrator provided) ── */

  if (orchestrator) {
    app.get("/api/scanner/state", async () => {
      return orchestrator.getState();
    });

    app.get("/api/scanner/signals", async () => {
      return orchestrator.getActiveSignals();
    });

    app.get("/api/scanner/stats", async () => {
      return orchestrator.getStats();
    });
  }

  /* ── Auth routes ── */

  app.post("/api/auth/login", async (req, reply) => {
    const { email } = req.body || {};
    if (!email || !email.includes("@")) {
      return reply.code(400).send({ error: "invalid_email" });
    }
    const result = await sendMagicLink(email);
    return result;
  });

  app.get("/auth/verify", async (req, reply) => {
    const { token } = req.query;
    if (!token) return reply.code(400).send({ error: "missing_token" });

    const result = verifyMagicLink(token);
    if (!result.ok) return reply.code(401).send({ error: result.error });

    // Set session cookie
    reply.header("Set-Cookie",
      `session=${encodeURIComponent(result.sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`
    );

    return reply.redirect("/");
  });

  app.get("/api/auth/me", async (req, reply) => {
    const cookieToken = parseCookie(req.headers.cookie, "session");
    const session = cookieToken ? verifySession(cookieToken) : null;
    if (!session) return reply.code(401).send({ error: "not_logged_in" });

    const sub = getByEmail(session.email);
    return {
      email: session.email,
      plan: sub?.plan || "free",
      status: sub?.status || "unknown"
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    reply.header("Set-Cookie", "session=; Path=/; HttpOnly; Max-Age=0");
    return { ok: true };
  });

  /* ── Stripe webhook ── */

  app.post("/api/stripe/webhook", {
    config: { rawBody: true }
  }, async (req, reply) => {
    const sig = req.headers["stripe-signature"];
    if (!sig) return reply.code(400).send({ error: "missing_signature" });

    try {
      // Fastify needs rawBody for Stripe verification
      const rawBody = req.rawBody || req.body;
      const event = verifyWebhookEvent(rawBody, sig);
      const result = handleWebhookEvent(event);

      // Post-webhook actions: grant platform access
      if (result.action === "activated" && result.subscriber) {
        if (result.telegramUserId) {
          linkTelegram(result.subscriber.email, result.telegramUserId);
          grantChannelAccess(result.telegramUserId).catch(() => {});
        }
        if (result.discordUserId) {
          linkDiscord(result.subscriber.email, result.discordUserId);
          grantPremiumRole(result.discordUserId).catch(() => {});
        }
      }

      return { received: true, action: result.action };
    } catch (err) {
      console.error("[stripe-webhook] Error:", err.message);
      return reply.code(400).send({ error: err.message });
    }
  });

  /* ── Subscriber stats (admin) ── */

  app.get("/api/admin/stats", { preHandler: requireAuth }, async (req) => {
    return {
      subscribers: getSubStats(),
      scanner: orchestrator ? orchestrator.getStats() : null,
      wsClients: getClientCount()
    };
  });

  /* ── Start poller (single-market mode when no orchestrator) ── */

  if (!orchestrator) {
    const poller = createPoller();
    const windowTracker = createWindowTracker();

    poller.start((state, err) => {
      if (!err && state) {
        windowTracker.onTick(state);
        broadcastState(state);
      }
    });
  }

  // Enable rawBody for Stripe webhook
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    try {
      req.rawBody = body;
      done(null, JSON.parse(body.toString()));
    } catch (err) {
      done(err);
    }
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Web dashboard: http://localhost:${PORT}`);
  console.log(`WebSocket:     ws://localhost:${PORT}/ws`);

  return app;
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
