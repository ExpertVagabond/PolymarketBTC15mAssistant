/**
 * Fastify HTTP + WebSocket server for the web dashboard.
 * Supports: auth (magic link), Stripe webhooks, multi-market scanner, subscriptions.
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebSocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import { addClient, broadcastState, getClientCount } from "./ws-handler.js";
import { createPoller } from "../core/poller.js";
import { createWindowTracker } from "../backtest/window-tracker.js";
import { getState, getHistory } from "../core/state.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import { getAllSourceHealth, getSystemStatus } from "../net/resilience.js";
import { getFreshness, checkStaleness } from "../net/data-freshness.js";
import { sendMagicLink, verifyMagicLink, verifySession, requireAuth, requireSubscription } from "./auth.js";
import { verifyWebhookEvent, handleWebhookEvent } from "../subscribers/stripe-webhook.js";
import { getByEmail, getStats as getSubStats } from "../subscribers/manager.js";
import { grantChannelAccess } from "../bots/telegram/access.js";
import { grantPremiumRole } from "../bots/discord/access.js";
import { linkTelegram, linkDiscord } from "../subscribers/manager.js";
import { getRecentSignals, getSignalStats, getFeatureWinRates, getComboWinRates, getTimeSeries, getCalibration, getDrawdownStats, exportSignals, getMarketStats, getPerformanceSummary, simulateStrategy, walkForwardValidation, getLeaderboard, getSignalById, getRegimeAnalytics } from "../signals/history.js";
import { getAllWeights, getLearningStatus } from "../engines/weights.js";
import { getOpenPositions, getPortfolioSummary, getRecentPositions } from "../portfolio/tracker.js";
import { generateKey, verifyKey, listKeys, revokeKey } from "../subscribers/api-keys.js";
import { addWebhook, listWebhooks, deleteWebhook, setEmailPrefs, getEmailPrefs, getThrottleStatus, flushDigestQueue } from "../notifications/dispatch.js";
import { queryLogs, getErrorTrends } from "../logging/structured-logger.js";
import { saveStrategy, listStrategies, getStrategy, deleteStrategy, backtestStrategy, compareStrategies } from "../strategies/library.js";
import { getEdgeAudit } from "../signals/edge-audit.js";
import { predictOpenPositions } from "../signals/settlement-predictor.js";
import { getDriftStatus, setBaseline, acknowledgeBaseline } from "../engines/model-drift-detector.js";
import { getQueueStatus, getRecentQueue, replayDelivery, startQueueProcessor, purgeQueue } from "../notifications/webhook-queue.js";
import { getPortfolioRisk } from "../portfolio/risk-attribution.js";
import { getUserDeliveryAudit, getGlobalDeliveryStats } from "../notifications/delivery-audit.js";
import { extractPlan, getPlanLimits, planRequired } from "./plan-gates.js";
import { createCheckoutUrl } from "../subscribers/stripe-webhook.js";
import { startTrial, getTrialStatus } from "../subscribers/trial.js";
import { getOrCreateReferralCode, claimReferral, getReferralStats } from "../referrals/tracker.js";
import { listAllSubscribers, grantCompAccess } from "../subscribers/manager.js";
import { getCacheStats, cachedResponse } from "./cache.js";
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

  /* ── Security middleware ── */

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false // allow inline scripts in dashboard
  });

  await app.register(fastifyCors, {
    origin: process.env.CORS_ORIGIN || true, // allow all in dev, set CORS_ORIGIN in prod
    methods: ["GET", "POST"]
  });

  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
    allowList: ["127.0.0.1", "::1"]
  });

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

  /* ── Health endpoints ── */

  const startTime = Date.now();

  app.get("/health", async () => {
    return { status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) };
  });

  app.get("/health/detailed", async () => {
    const sources = getAllSourceHealth();
    const systemStatus = getSystemStatus();
    const mem = process.memoryUsage();
    const stats = orchestrator ? orchestrator.getStats() : null;

    return {
      status: systemStatus,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      sources,
      scanner: stats ? {
        tracked: stats.tracked,
        withSignal: stats.withSignal,
        categories: stats.categories
      } : null,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024) + "MB",
        heap: Math.round(mem.heapUsed / 1024 / 1024) + "MB",
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + "MB"
      },
      wsClients: getClientCount(),
      freshness: getFreshness(),
      staleness: checkStaleness(),
      timestamp: new Date().toISOString()
    };
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

  /* ── Public Stats API (no auth required) ── */

  app.get("/api/public-stats", async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    return cachedResponse(`public-stats:${days}`, 300_000, () => {
      const stats = getSignalStats();
      const perf = getPerformanceSummary(days);
      const ts = getTimeSeries(days);
      const dd = getDrawdownStats();
      const cal = getCalibration();

      return {
        period: `${days}d`,
        winRate: stats.winRate,
        totalSignals: stats.totalSignals,
        settled: (stats.wins || 0) + (stats.losses || 0),
        wins: stats.wins || 0,
        losses: stats.losses || 0,
        totalPnl: perf.total_pnl,
        avgPnl: perf.avg_pnl,
        sharpe: perf.sharpe,
        maxDrawdown: dd.maxDrawdown,
        bestTrade: perf.best_trade,
        worstTrade: perf.worst_trade,
        avgConfidence: perf.avg_confidence,
        byCategory: stats.byCategory || [],
        byStrength: stats.byStrength || [],
        timeSeries: ts.slice(-30),
        calibration: cal,
        equityCurve: (dd.equityCurve || []).slice(-90),
        streak: dd.currentStreak,
        timestamp: new Date().toISOString()
      };
    });
  });

  /* ── Signal History API ── */

  app.get("/api/signals/recent", async (req) => {
    const plan = extractPlan(req);
    const limits = getPlanLimits(plan);
    const limit = Math.min(Number(req.query.limit) || 50, limits.recentSignalsLimit);
    const signals = getRecentSignals(limit);
    return plan === "free" ? signals.map(s => ({ ...s, kelly_bet_pct: undefined })) : signals;
  });

  app.get("/api/signals/stats", async () => {
    return cachedResponse("signals-stats", 30_000, () => getSignalStats());
  });

  /* ── Analytics API ── */

  app.get("/api/analytics/timeseries", async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    return getTimeSeries(days);
  });

  app.get("/api/analytics/calibration", async () => {
    return cachedResponse("analytics-calibration", 120_000, () => getCalibration());
  });

  app.get("/api/analytics/drawdown", async () => {
    return cachedResponse("analytics-drawdown", 120_000, () => getDrawdownStats());
  });

  app.get("/api/analytics/performance", async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    return getPerformanceSummary(days);
  });

  app.get("/api/analytics/regime", async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    return getRegimeAnalytics(days);
  });

  app.get("/api/analytics/market/:marketId", async (req) => {
    const stats = getMarketStats(req.params.marketId);
    return stats || { error: "no_data", marketId: req.params.marketId };
  });

  app.get("/api/analytics/export", async (req) => {
    const plan = extractPlan(req);
    if (!getPlanLimits(plan).analyticsExport) return planRequired("pro");
    const opts = {
      days: req.query.days ? Number(req.query.days) : undefined,
      category: req.query.category || undefined,
      limit: Number(req.query.limit) || 1000
    };
    const rows = exportSignals(opts);
    const format = req.query.format || "json";

    if (format === "csv") {
      if (rows.length === 0) return "no data";
      const headers = Object.keys(rows[0]);
      const csvLines = [headers.join(",")];
      for (const row of rows) {
        csvLines.push(headers.map((h) => {
          const val = row[h];
          if (val == null) return "";
          const str = String(val);
          return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(","));
      }
      return { csv: csvLines.join("\n"), count: rows.length };
    }

    return { signals: rows, count: rows.length };
  });

  /* ── Strategy Simulator API ── */

  app.get("/api/simulate", async (req) => {
    const plan = extractPlan(req);
    if (!getPlanLimits(plan).simulatorAccess) return planRequired("pro");
    const filters = {};
    if (req.query.minConfidence) filters.minConfidence = Number(req.query.minConfidence);
    if (req.query.maxConfidence) filters.maxConfidence = Number(req.query.maxConfidence);
    if (req.query.categories) filters.categories = req.query.categories.split(",");
    if (req.query.strengths) filters.strengths = req.query.strengths.split(",");
    if (req.query.minEdge) filters.minEdge = Number(req.query.minEdge);
    if (req.query.sides) filters.sides = req.query.sides.split(",");
    return simulateStrategy(filters);
  });

  /* ── Walk-Forward Validation API ── */

  app.get("/api/simulate/walk-forward", async (req) => {
    const plan = extractPlan(req);
    if (!getPlanLimits(plan).simulatorAccess) return planRequired("pro");
    const filters = {};
    if (req.query.minConfidence) filters.minConfidence = Number(req.query.minConfidence);
    if (req.query.maxConfidence) filters.maxConfidence = Number(req.query.maxConfidence);
    if (req.query.categories) filters.categories = req.query.categories.split(",");
    if (req.query.strengths) filters.strengths = req.query.strengths.split(",");
    if (req.query.minEdge) filters.minEdge = Number(req.query.minEdge);
    if (req.query.sides) filters.sides = req.query.sides.split(",");
    return walkForwardValidation(filters);
  });

  /* ── Strategy Library API ── */

  app.get("/api/strategies", async () => {
    return listStrategies();
  });

  app.post("/api/strategies", async (req) => {
    const { name, filters, description } = req.body || {};
    if (!name) return { error: "name_required" };
    const result = saveStrategy(name, filters || {}, description);
    return result;
  });

  app.get("/api/strategies/:id/backtest", async (req) => {
    try {
      return backtestStrategy(Number(req.params.id));
    } catch (e) {
      return { error: e.message };
    }
  });

  app.get("/api/strategies/compare", async (req) => {
    const a = Number(req.query.a);
    const b = Number(req.query.b);
    if (!a || !b) return { error: "provide ?a=ID&b=ID" };
    try {
      return compareStrategies(a, b);
    } catch (e) {
      return { error: e.message };
    }
  });

  app.delete("/api/strategies/:id", async (req) => {
    return { deleted: deleteStrategy(Number(req.params.id)) };
  });

  /* ── Leaderboard API ── */

  app.get("/api/leaderboard", async () => {
    return getLeaderboard();
  });

  /* ── Signal Detail + Share ── */

  app.get("/api/signal/:id", async (req) => {
    const signal = getSignalById(Number(req.params.id));
    return signal || { error: "not_found" };
  });

  app.get("/s/:id", async (req, reply) => {
    const signal = getSignalById(Number(req.params.id));
    if (!signal) return reply.code(404).send("Signal not found");

    const side = signal.side === "UP" ? "YES" : "NO";
    const edge = signal.edge != null ? "+" + (signal.edge * 100).toFixed(1) + "%" : "";
    const conf = signal.confidence != null ? signal.confidence : "";
    const outcome = signal.outcome || "OPEN";
    const title = `BUY ${side} — ${(signal.question || "").slice(0, 60)}`;
    const desc = `Edge: ${edge} | Confidence: ${conf} | ${outcome} | ${signal.category || ""}`;

    reply.header("Content-Type", "text/html");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(title)} | PolySignal</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b11;color:#c8c8d0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 20px}
.card{background:#12121a;border:1px solid #1e1e2a;border-radius:12px;padding:24px;max-width:500px;width:100%}
h2{font-size:16px;color:#fff;margin-bottom:12px}
.side{font-size:20px;font-weight:800;margin-bottom:6px;color:${signal.side === "UP" ? "#34d399" : "#f87171"}}
.question{font-size:14px;color:#d1d5db;margin-bottom:16px;line-height:1.4}
.metrics{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px}
.metric{text-align:center}.metric-label{font-size:10px;text-transform:uppercase;color:#4b5563;margin-bottom:2px}.metric-val{font-size:18px;font-weight:700}
.green{color:#34d399}.red{color:#f87171}.amber{color:#fbbf24}
.outcome{text-align:center;font-size:14px;font-weight:700;padding:8px;border-radius:6px;margin-bottom:16px}
.outcome.WIN{background:#34d39920;color:#34d399}.outcome.LOSS{background:#f8717120;color:#f87171}.outcome.OPEN{background:#fbbf2420;color:#fbbf24}
.back{display:inline-block;margin-top:20px;color:#6b7280;font-size:12px;text-decoration:none}.back:hover{color:#a5b4fc}
.brand{font-size:11px;color:#27272f;margin-top:20px}
</style>
</head>
<body>
<div class="card">
<div class="side">BUY ${esc(side)}</div>
<div class="question">${esc(signal.question || "Unknown market")}</div>
<div class="metrics">
<div class="metric"><div class="metric-label">Edge</div><div class="metric-val green">${edge || "-"}</div></div>
<div class="metric"><div class="metric-label">Confidence</div><div class="metric-val">${conf || "-"}</div></div>
<div class="metric"><div class="metric-label">Strength</div><div class="metric-val amber">${esc(signal.strength || "-")}</div></div>
</div>
<div class="outcome ${esc(outcome)}">${esc(outcome)}${signal.pnl_pct != null ? " | P&L: " + (signal.pnl_pct >= 0 ? "+" : "") + (signal.pnl_pct * 100).toFixed(1) + "%" : ""}</div>
<div style="font-size:11px;color:#4b5563;text-align:center">${esc(signal.category || "other")} | ${signal.created_at || ""}</div>
</div>
<a href="/" class="back">Open PolySignal Dashboard</a>
<div class="brand">PolySignal — AI-powered Polymarket signal scanner</div>
</body></html>`;
  });

  /* ── Portfolio API ── */

  app.get("/api/portfolio/positions", async () => {
    return getOpenPositions();
  });

  app.get("/api/portfolio/summary", async () => {
    return getPortfolioSummary();
  });

  app.get("/api/portfolio/recent", async (req) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    return getRecentPositions(limit);
  });

  /* ── Learning / Feedback API ── */

  app.get("/api/learning/weights", async () => {
    return getAllWeights();
  });

  app.get("/api/learning/features", async () => {
    return getFeatureWinRates(5);
  });

  app.get("/api/learning/combos", async () => {
    return getComboWinRates(5);
  });

  app.get("/api/learning/status", async () => {
    return getLearningStatus();
  });

  /* ── Plan check (public, returns free if not logged in) ── */

  app.get("/api/plan", async (req) => {
    const cookieToken = parseCookie(req.headers.cookie, "session");
    const session = cookieToken ? verifySession(cookieToken) : null;
    if (!session) return { plan: "free" };
    const sub = getByEmail(session.email);
    return { plan: sub?.plan || "free", email: session.email };
  });

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
      signals: getSignalStats(),
      wsClients: getClientCount()
    };
  });

  /* ── Error Logs API ── */

  app.get("/api/logs", async (req) => {
    const { source, level, category, days, limit, offset } = req.query;
    return queryLogs({ source, level, category, days: Number(days) || 7, limit: Number(limit) || 50, offset: Number(offset) || 0 });
  });

  app.get("/api/logs/trends", async (req) => {
    return getErrorTrends(Number(req.query.days) || 7);
  });

  /* ── Portfolio Risk API ── */

  app.get("/api/portfolio/risk", async () => {
    return getPortfolioRisk();
  });

  /* ── Signals by Date API ── */

  app.get("/api/signals/by-date", async (req) => {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "provide ?date=YYYY-MM-DD" };
    return getRecentSignals(500).filter(s => s.created_at && s.created_at.startsWith(date));
  });

  /* ── Delivery Audit API ── */

  app.get("/api/notifications/delivery-audit", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return getUserDeliveryAudit(email);
  });

  app.get("/api/admin/delivery-stats", async () => {
    return getGlobalDeliveryStats(7);
  });

  /* ── Edge Audit API ── */

  app.get("/api/analytics/edge-audit", async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    return getEdgeAudit(days);
  });

  /* ── Settlement Predictions API ── */

  app.get("/api/portfolio/predictions", async () => {
    return predictOpenPositions();
  });

  /* ── Model Drift API ── */

  app.get("/api/learning/drift-status", async () => {
    return getDriftStatus();
  });

  app.post("/api/learning/drift-baseline", async () => {
    return acknowledgeBaseline();
  });

  /* ── Webhook Queue API ── */

  app.get("/api/admin/webhook-queue", async () => {
    return { status: getQueueStatus(), recent: getRecentQueue(20) };
  });

  app.post("/api/admin/webhook-queue/replay/:id", async (req) => {
    const ok = replayDelivery(Number(req.params.id));
    return { replayed: ok };
  });

  app.post("/api/admin/webhook-queue/purge", async (req) => {
    const days = Math.max(Number(req.query.days) || 7, 1);
    const result = purgeQueue(days);
    return { purged: result.changes };
  });

  /* ── Stripe Checkout API ── */

  app.post("/api/checkout/create", { preHandler: requireAuth }, async (req) => {
    const plan = req.body?.plan || "basic";
    const priceId = plan === "pro" ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_BASIC;
    if (!priceId) return { error: "stripe_not_configured", message: "Set STRIPE_PRICE_BASIC / STRIPE_PRICE_PRO env vars" };
    const email = req.sessionUser?.email;
    try {
      const url = await createCheckoutUrl({ priceId, email, metadata: { plan, source: "web" } });
      return { url };
    } catch (err) {
      return { error: "checkout_failed", message: err.message };
    }
  });

  /* ── Free Trial API ── */

  app.post("/api/trial/start", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return startTrial(email);
  });

  app.get("/api/trial/status", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return getTrialStatus(email);
  });

  /* ── Referral API ── */

  app.get("/api/referral/code", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return getOrCreateReferralCode(email);
  });

  app.post("/api/referral/claim", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    const code = req.body?.code;
    if (!email || !code) return { error: "missing_params" };
    return claimReferral(code, email);
  });

  app.get("/api/referral/stats", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return getReferralStats(email);
  });

  /* ── Admin: User Management ── */

  app.get("/api/admin/subscribers", { preHandler: requireAuth }, async (req) => {
    const plan = req.query.plan || null;
    const status = req.query.status || null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    return listAllSubscribers({ plan, status, limit });
  });

  app.post("/api/admin/grant-comp", { preHandler: requireAuth }, async (req) => {
    const email = req.body?.email;
    const days = Math.min(Number(req.body?.days) || 30, 365);
    const plan = req.body?.plan || "pro";
    if (!email) return { error: "missing_email" };
    return grantCompAccess(email, plan, days);
  });

  app.get("/api/admin/cache-stats", async () => {
    return getCacheStats();
  });

  /* ── API Key Auth (X-API-Key header) ── */

  function requireApiKeyOrSession(req, reply, done) {
    const apiKey = req.headers["x-api-key"];
    if (apiKey) {
      const result = verifyKey(apiKey);
      if (result) {
        req.apiKeyUser = result;
        done();
        return;
      }
      reply.code(401).send({ error: "invalid_api_key" });
      return;
    }
    // Fall back to session auth
    const cookieToken = parseCookie(req.headers.cookie, "session");
    const session = cookieToken ? verifySession(cookieToken) : null;
    if (!session) {
      reply.code(401).send({ error: "auth_required", hint: "Provide X-API-Key header or session cookie" });
      return;
    }
    req.sessionUser = session;
    done();
  }

  /* ── API Key Management Routes ── */

  app.post("/api/keys/generate", { preHandler: requireAuth }, async (req) => {
    const name = req.body?.name || "default";
    const email = req.sessionUser?.email || req.body?.email;
    if (!email) return { error: "no_email" };
    try {
      const result = generateKey(email, name);
      return { ok: true, ...result };
    } catch (err) {
      return { error: err.message };
    }
  });

  app.get("/api/keys", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return listKeys(email);
  });

  app.delete("/api/keys/:id", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    const ok = revokeKey(Number(req.params.id), email);
    return { ok };
  });

  /* ── Webhook Management Routes ── */

  app.post("/api/webhooks", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    const { url, name } = req.body || {};
    if (!email) return { error: "no_email" };
    if (!url || !url.startsWith("https://")) return { error: "invalid_url", hint: "URL must start with https://" };
    try {
      addWebhook(email, url, name || "default");
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  app.get("/api/webhooks", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return listWebhooks(email);
  });

  app.delete("/api/webhooks/:id", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    const ok = deleteWebhook(Number(req.params.id), email);
    return { ok };
  });

  /* ── Email Alert Preferences ── */

  app.get("/api/email-prefs", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return getEmailPrefs(email) || { alerts_enabled: 0, min_confidence: 60, categories: null };
  });

  app.post("/api/email-prefs", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    const { alertsEnabled, minConfidence, categories, maxAlertsPerHour } = req.body || {};
    setEmailPrefs(email, { alertsEnabled, minConfidence, categories, maxAlertsPerHour });
    return { ok: true };
  });

  app.get("/api/throttle-status", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return getThrottleStatus(email);
  });

  app.post("/api/digest/flush", { preHandler: requireAuth }, async (req) => {
    const email = req.sessionUser?.email;
    if (!email) return { error: "no_email" };
    return { queued: flushDigestQueue(email) };
  });

  /* ── Programmatic API (API key or session auth) ── */

  app.get("/api/v1/signals", { preHandler: requireApiKeyOrSession }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    return getRecentSignals(limit);
  });

  app.get("/api/v1/stats", { preHandler: requireApiKeyOrSession }, async () => {
    return getSignalStats();
  });

  app.get("/api/v1/scanner", { preHandler: requireApiKeyOrSession }, async () => {
    if (!orchestrator) return { error: "no_scanner" };
    return { signals: orchestrator.getActiveSignals(), stats: orchestrator.getStats() };
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

  // Start webhook delivery queue processor
  startQueueProcessor();

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Web dashboard: http://localhost:${PORT}`);
  console.log(`WebSocket:     ws://localhost:${PORT}/ws`);

  return app;
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
