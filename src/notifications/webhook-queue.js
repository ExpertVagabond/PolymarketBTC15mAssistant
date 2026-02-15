/**
 * Durable webhook delivery queue with retry, backoff, and replay.
 * Stores delivery attempts in SQLite for guaranteed delivery tracking.
 */

import { getDb } from "../subscribers/db.js";

let stmts = null;
let retryTimer = null;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 5_000;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT,
      next_retry_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wq_status ON webhook_queue(status);
    CREATE INDEX IF NOT EXISTS idx_wq_next_retry ON webhook_queue(next_retry_at);
  `);

  stmts = {
    enqueue: db.prepare(`
      INSERT INTO webhook_queue (webhook_id, url, payload)
      VALUES (@webhook_id, @url, @payload)
    `),
    getPending: db.prepare(`
      SELECT * FROM webhook_queue
      WHERE status IN ('pending', 'retrying')
        AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
      ORDER BY created_at ASC LIMIT 50
    `),
    markDelivered: db.prepare(`
      UPDATE webhook_queue SET status = 'delivered', delivered_at = datetime('now'), attempts = attempts + 1
      WHERE id = ?
    `),
    markFailed: db.prepare(`
      UPDATE webhook_queue
      SET status = CASE WHEN attempts + 1 >= ${MAX_RETRIES} THEN 'failed' ELSE 'retrying' END,
          attempts = attempts + 1,
          last_attempt_at = datetime('now'),
          last_error = @error,
          next_retry_at = datetime('now', @delay)
      WHERE id = @id
    `),
    getQueueStatus: db.prepare(`
      SELECT status, COUNT(*) as count FROM webhook_queue
      GROUP BY status
    `),
    getRecent: db.prepare(`
      SELECT id, webhook_id, url, status, attempts, last_error, created_at, delivered_at
      FROM webhook_queue ORDER BY created_at DESC LIMIT @limit
    `),
    getById: db.prepare("SELECT * FROM webhook_queue WHERE id = ?"),
    resetForRetry: db.prepare(`
      UPDATE webhook_queue SET status = 'retrying', next_retry_at = NULL, attempts = 0
      WHERE id = ? AND status = 'failed'
    `),
    purgeOld: db.prepare("DELETE FROM webhook_queue WHERE created_at < datetime('now', ?)")
  };
}

/**
 * Enqueue a webhook delivery.
 */
export function enqueueWebhook(webhookId, url, payload) {
  if (!stmts) ensureTable();
  stmts.enqueue.run({
    webhook_id: webhookId,
    url,
    payload: JSON.stringify(payload)
  });
}

/**
 * Process pending deliveries in the queue.
 * Called periodically by the retry timer.
 */
export async function processQueue() {
  if (!stmts) ensureTable();
  const pending = stmts.getPending.all();
  if (pending.length === 0) return;

  for (const item of pending) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(item.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "PolySignal/1.0" },
        body: item.payload,
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        stmts.markDelivered.run(item.id);
      } else {
        const delay = `+${Math.min(BASE_DELAY_MS * Math.pow(2, item.attempts), 300_000) / 1000} seconds`;
        stmts.markFailed.run({ id: item.id, error: `HTTP ${res.status}`, delay });
      }
    } catch (err) {
      const delay = `+${Math.min(BASE_DELAY_MS * Math.pow(2, item.attempts), 300_000) / 1000} seconds`;
      stmts.markFailed.run({ id: item.id, error: err.message, delay });
    }
  }
}

/**
 * Get queue status summary.
 */
export function getQueueStatus() {
  if (!stmts) ensureTable();
  const rows = stmts.getQueueStatus.all();
  const status = {};
  for (const r of rows) status[r.status] = r.count;
  return { ...status, total: Object.values(status).reduce((a, b) => a + b, 0) };
}

/**
 * Get recent queue entries.
 */
export function getRecentQueue(limit = 20) {
  if (!stmts) ensureTable();
  return stmts.getRecent.all({ limit: Math.min(limit, 100) });
}

/**
 * Replay a failed delivery (reset for retry).
 */
export function replayDelivery(id) {
  if (!stmts) ensureTable();
  const result = stmts.resetForRetry.run(id);
  return result.changes > 0;
}

/**
 * Start the retry processor (runs every 30 seconds).
 */
export function startQueueProcessor() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    processQueue().catch(err => console.error("[webhook-queue] Process error:", err.message));
  }, 30_000);
  // Also run immediately
  processQueue().catch(() => {});
}

/**
 * Stop the retry processor.
 */
export function stopQueueProcessor() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

/**
 * Purge old delivered/failed entries.
 */
export function purgeQueue(days = 7) {
  if (!stmts) ensureTable();
  return stmts.purgeOld.run(`-${Math.max(days, 1)} days`);
}
