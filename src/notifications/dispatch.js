/**
 * Notification dispatch: webhooks + email alerts + throttling.
 *
 * Sends signal notifications to:
 * 1. Custom webhook URLs (user-registered endpoints)
 * 2. Email alerts (via Resend, for subscribers with email_alerts enabled)
 *
 * Throttling: per-user rate limiting with configurable max alerts/hour.
 * Excess signals are queued and can be retrieved as a digest.
 *
 * All dispatches are fire-and-forget with error logging.
 */

import { getDb } from "../subscribers/db.js";
import { enqueueWebhook } from "./webhook-queue.js";
import { recordDelivery } from "./delivery-audit.js";

let stmts = null;

/* ── In-memory per-user throttle tracker ── */
const userThrottles = new Map(); // email -> { count, windowStart, queued[] }
const DEFAULT_MAX_PER_HOUR = 20;

function getThrottle(email) {
  const now = Date.now();
  let t = userThrottles.get(email);
  if (!t || now - t.windowStart > 3_600_000) {
    t = { count: 0, windowStart: now, queued: [] };
    userThrottles.set(email, t);
  }
  return t;
}

function isThrottled(email, maxPerHour) {
  const t = getThrottle(email);
  return t.count >= (maxPerHour || DEFAULT_MAX_PER_HOUR);
}

function recordSent(email) {
  const t = getThrottle(email);
  t.count++;
}

function queueForDigest(email, tick) {
  const t = getThrottle(email);
  if (t.queued.length < 50) { // cap queue at 50
    t.queued.push({ question: tick.question, side: tick.side, confidence: tick.confidence, edge: tick.edge, ts: Date.now() });
  }
}

/**
 * Get queued (throttled) signals for a user's digest, then clear the queue.
 */
export function flushDigestQueue(email) {
  const t = userThrottles.get(email);
  if (!t || t.queued.length === 0) return [];
  const items = [...t.queued];
  t.queued = [];
  return items;
}

/**
 * Get throttle status for a user.
 */
export function getThrottleStatus(email) {
  const t = getThrottle(email);
  return { count: t.count, maxPerHour: DEFAULT_MAX_PER_HOUR, queuedCount: t.queued.length, windowStart: new Date(t.windowStart).toISOString() };
}

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      url TEXT NOT NULL,
      name TEXT DEFAULT 'default',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_sent_at TEXT,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      last_error TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_prefs (
      email TEXT PRIMARY KEY,
      alerts_enabled INTEGER DEFAULT 0,
      min_confidence INTEGER DEFAULT 60,
      categories TEXT,
      max_alerts_per_hour INTEGER DEFAULT 20,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Safe migration: add max_alerts_per_hour column if missing
  const cols = db.prepare("PRAGMA table_info(email_prefs)").all().map(c => c.name);
  if (!cols.includes("max_alerts_per_hour")) {
    db.exec("ALTER TABLE email_prefs ADD COLUMN max_alerts_per_hour INTEGER DEFAULT 20");
  }

  stmts = {
    addWebhook: db.prepare("INSERT INTO webhooks (email, url, name) VALUES (?, ?, ?)"),
    listWebhooks: db.prepare("SELECT * FROM webhooks WHERE email = ? ORDER BY created_at DESC"),
    activeWebhooks: db.prepare("SELECT * FROM webhooks WHERE active = 1"),
    deleteWebhook: db.prepare("DELETE FROM webhooks WHERE id = ? AND email = ?"),
    recordSuccess: db.prepare("UPDATE webhooks SET last_sent_at = datetime('now'), success_count = success_count + 1, last_error = NULL WHERE id = ?"),
    recordFail: db.prepare("UPDATE webhooks SET fail_count = fail_count + 1, last_error = ? WHERE id = ?"),
    deactivate: db.prepare("UPDATE webhooks SET active = 0 WHERE id = ?"),
    getEmailPrefs: db.prepare("SELECT * FROM email_prefs WHERE email = ?"),
    setEmailPrefs: db.prepare(`INSERT INTO email_prefs (email, alerts_enabled, min_confidence, categories, max_alerts_per_hour) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET alerts_enabled=excluded.alerts_enabled, min_confidence=excluded.min_confidence, categories=excluded.categories, max_alerts_per_hour=excluded.max_alerts_per_hour`),
    activeEmailPrefs: db.prepare("SELECT * FROM email_prefs WHERE alerts_enabled = 1")
  };
}

/**
 * Add a webhook endpoint for a subscriber.
 */
export function addWebhook(email, url, name = "default") {
  if (!stmts) ensureTable();
  // Limit to 5 webhooks per email
  const existing = stmts.listWebhooks.all(email);
  if (existing.length >= 5) throw new Error("max_webhooks_reached");
  stmts.addWebhook.run(email, url, name);
}

/**
 * List webhooks for a subscriber.
 */
export function listWebhooks(email) {
  if (!stmts) ensureTable();
  return stmts.listWebhooks.all(email);
}

/**
 * Delete a webhook by ID (must belong to the given email).
 */
export function deleteWebhook(id, email) {
  if (!stmts) ensureTable();
  const result = stmts.deleteWebhook.run(id, email);
  return result.changes > 0;
}

/**
 * Set email alert preferences (with optional throttle config).
 */
export function setEmailPrefs(email, { alertsEnabled = false, minConfidence = 60, categories = null, maxAlertsPerHour = 20 } = {}) {
  if (!stmts) ensureTable();
  stmts.setEmailPrefs.run(email, alertsEnabled ? 1 : 0, minConfidence, categories ? JSON.stringify(categories) : null, Math.max(1, Math.min(maxAlertsPerHour, 100)));
}

/**
 * Get email alert preferences.
 */
export function getEmailPrefs(email) {
  if (!stmts) ensureTable();
  const row = stmts.getEmailPrefs.get(email);
  if (!row) return null;
  return { ...row, categories: row.categories ? JSON.parse(row.categories) : null, maxAlertsPerHour: row.max_alerts_per_hour ?? 20 };
}

/**
 * Dispatch a signal to all active webhooks.
 * Fire-and-forget; errors are logged but don't block.
 */
export async function dispatchWebhooks(tick) {
  if (!stmts) ensureTable();
  const webhooks = stmts.activeWebhooks.all();
  if (webhooks.length === 0) return;

  const payload = formatSignalPayload(tick);

  for (const wh of webhooks) {
    // Enqueue for durable delivery with retry instead of fire-and-forget
    enqueueWebhook(wh.id, wh.url, payload);
    recordDelivery({ email: wh.email, channel: "webhook", signalId: tick.signalId, status: "queued" });
  }
}

async function sendWebhook(wh, payload) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(wh.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "PolySignal/1.0" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (res.ok) {
      stmts.recordSuccess.run(wh.id);
    } else {
      const errMsg = `HTTP ${res.status}`;
      stmts.recordFail.run(errMsg, wh.id);
      // Deactivate after 10 consecutive failures
      if (wh.fail_count >= 9) {
        stmts.deactivate.run(wh.id);
        console.log(`[webhooks] Deactivated webhook ${wh.id} after 10 failures`);
      }
    }
  } catch (err) {
    stmts.recordFail.run(err.message, wh.id);
    if (wh.fail_count >= 9) {
      stmts.deactivate.run(wh.id);
    }
  }
}

/**
 * Send email alerts to all subscribers who opted in.
 */
export async function dispatchEmailAlerts(tick, resendClient) {
  if (!stmts) ensureTable();
  if (!resendClient) return;

  const prefs = stmts.activeEmailPrefs.all();
  if (prefs.length === 0) return;

  const confidence = tick.confidence ?? 0;
  const category = (tick.category || "").toLowerCase();

  for (const pref of prefs) {
    // Check confidence threshold
    if (confidence < (pref.min_confidence || 0)) continue;

    // Check category filter
    if (pref.categories) {
      const cats = JSON.parse(pref.categories).map(c => c.toLowerCase());
      if (cats.length > 0 && !cats.includes(category)) continue;
    }

    // Throttle check
    const maxPerHour = pref.max_alerts_per_hour ?? DEFAULT_MAX_PER_HOUR;
    if (isThrottled(pref.email, maxPerHour)) {
      queueForDigest(pref.email, tick);
      recordDelivery({ email: pref.email, channel: "email", signalId: tick.signalId, status: "throttled" });
      continue;
    }

    recordSent(pref.email);
    const emailStart = Date.now();
    sendEmailAlert(pref.email, tick, resendClient).then(() => {
      recordDelivery({ email: pref.email, channel: "email", signalId: tick.signalId, status: "delivered", latencyMs: Date.now() - emailStart });
    }).catch(err => {
      recordDelivery({ email: pref.email, channel: "email", signalId: tick.signalId, status: "failed", error: err.message });
      console.error(`[email-alert] Failed for ${pref.email}:`, err.message);
    });
  }
}

async function sendEmailAlert(email, tick, resend) {
  const side = tick.side === "UP" ? "BUY YES" : "BUY NO";
  const edge = tick.edge != null ? (tick.edge * 100).toFixed(1) : "?";
  const conf = tick.confidence ?? "?";
  const question = tick.question || "Unknown market";

  await resend.emails.send({
    from: process.env.RESEND_FROM || "PolySignal <alerts@polysignal.io>",
    to: email,
    subject: `[PolySignal] ${side}: ${question.slice(0, 50)}`,
    html: `
      <div style="font-family:system-ui;max-width:500px;margin:0 auto;padding:20px">
        <h2 style="color:#fff;background:#0b0b11;padding:14px 20px;border-radius:8px;margin:0 0 16px">${side}</h2>
        <p style="font-size:15px;color:#333"><strong>${question}</strong></p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#666">Edge</td><td style="padding:6px 0;font-weight:600">+${edge}%</td></tr>
          <tr><td style="padding:6px 0;color:#666">Confidence</td><td style="padding:6px 0;font-weight:600">${conf}/100</td></tr>
          <tr><td style="padding:6px 0;color:#666">Category</td><td style="padding:6px 0">${tick.category || "-"}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Strength</td><td style="padding:6px 0">${tick.strength || "-"}</td></tr>
        </table>
        <p style="font-size:12px;color:#999;margin-top:20px">You're receiving this because you enabled email alerts on PolySignal.</p>
      </div>
    `
  });
}

function formatSignalPayload(tick) {
  return {
    event: tick.signal === "SETTLED" ? "signal.settled" : "signal.enter",
    timestamp: new Date().toISOString(),
    data: {
      question: tick.question,
      category: tick.category,
      side: tick.side,
      signal: tick.signal,
      strength: tick.strength,
      edge: tick.edge,
      confidence: tick.confidence,
      confidenceTier: tick.confidenceTier,
      modelUp: tick.modelUp,
      priceUp: tick.priceUp,
      priceDown: tick.priceDown,
      kelly: tick.kelly,
      settlementLeftMin: tick.settlementLeftMin,
      settlementMsg: tick.settlementMsg
    }
  };
}

/**
 * Dispatch trade event notifications to all active webhooks.
 * Called by the audit log hook when trade events occur.
 *
 * @param {string} eventType - e.g. "trade.opened", "trade.closed", "risk.circuit_breaker"
 * @param {object} data - Event data (executionId, marketId, side, amount, pnlUsd, etc.)
 */
export async function dispatchTradeEvent(eventType, data = {}) {
  if (!stmts) ensureTable();
  const webhooks = stmts.activeWebhooks.all();
  if (webhooks.length === 0) return;

  const payload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    data: {
      executionId: data.executionId || null,
      marketId: data.marketId || null,
      question: data.question || null,
      side: data.side || null,
      category: data.category || null,
      amount: data.amount || null,
      price: data.price || null,
      pnlUsd: data.pnlUsd || null,
      pnlPct: data.pnlPct || null,
      closeReason: data.closeReason || null,
      dryRun: data.dryRun != null ? data.dryRun : true,
      detail: data.detail || null
    }
  };

  for (const wh of webhooks) {
    enqueueWebhook(wh.id, wh.url, payload);
  }
}

// Trade events that trigger notifications
const NOTIFY_EVENTS = new Set([
  "POSITION_OPENED", "POSITION_CLOSED", "ORDER_FILLED", "ORDER_FILL_FAILED",
  "ORDER_REJECTED", "CIRCUIT_BREAKER", "BOT_STATE_CHANGE"
]);

// Map audit event types to webhook event names
const EVENT_MAP = {
  "POSITION_OPENED": "trade.opened",
  "POSITION_CLOSED": "trade.closed",
  "ORDER_FILLED": "trade.filled",
  "ORDER_FILL_FAILED": "trade.fill_failed",
  "ORDER_REJECTED": "trade.rejected",
  "ORDER_PARTIAL_FILL": "trade.partial_fill",
  "CIRCUIT_BREAKER": "risk.circuit_breaker",
  "BOT_STATE_CHANGE": "bot.state_change",
  "RISK_BLOCKED": "risk.blocked"
};

/**
 * Hook for audit-log integration.
 * Call this from logAuditEvent to auto-dispatch trade notifications.
 */
export function onTradeAuditEvent(auditEventType, data) {
  if (!NOTIFY_EVENTS.has(auditEventType)) return;
  const webhookEvent = EVENT_MAP[auditEventType] || `trade.${auditEventType.toLowerCase()}`;
  dispatchTradeEvent(webhookEvent, data).catch(() => {});
}
