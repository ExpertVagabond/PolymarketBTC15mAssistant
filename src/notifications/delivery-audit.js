/**
 * Notification delivery audit log — per-user tracking of webhook and email delivery.
 * Records each delivery attempt with status, latency, and error details.
 */

import { getDb } from "../subscribers/db.js";

let stmts = null;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      channel TEXT NOT NULL,
      signal_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      latency_ms INTEGER,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dl_email ON delivery_log(email);
    CREATE INDEX IF NOT EXISTS idx_dl_created ON delivery_log(created_at);
  `);

  stmts = {
    record: db.prepare(`
      INSERT INTO delivery_log (email, channel, signal_id, status, latency_ms, error)
      VALUES (@email, @channel, @signal_id, @status, @latency_ms, @error)
    `),
    getByUser: db.prepare(`
      SELECT id, channel, signal_id, status, latency_ms, error, created_at
      FROM delivery_log WHERE email = ? ORDER BY created_at DESC LIMIT @limit
    `),
    getUserStats: db.prepare(`
      SELECT
        channel,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'throttled' THEN 1 ELSE 0 END) as throttled,
        AVG(CASE WHEN status = 'delivered' THEN latency_ms END) as avg_latency_ms
      FROM delivery_log WHERE email = ?
        AND created_at >= datetime('now', @offset)
      GROUP BY channel
    `),
    getGlobalStats: db.prepare(`
      SELECT
        channel,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(CASE WHEN status = 'delivered' THEN latency_ms END) as avg_latency_ms
      FROM delivery_log
        WHERE created_at >= datetime('now', @offset)
      GROUP BY channel
    `),
    purge: db.prepare("DELETE FROM delivery_log WHERE created_at < datetime('now', ?)")
  };
}

/**
 * Record a delivery attempt.
 */
export function recordDelivery({ email, channel, signalId, status, latencyMs, error }) {
  if (!stmts) ensureTable();
  stmts.record.run({
    email: email || "system",
    channel,
    signal_id: signalId || null,
    status,
    latency_ms: latencyMs || null,
    error: error || null
  });
}

/**
 * Get delivery audit for a specific user.
 */
export function getUserDeliveryAudit(email, limit = 20) {
  if (!stmts) ensureTable();
  const recent = stmts.getByUser.all(email, { limit: Math.min(limit, 100) });
  const stats = stmts.getUserStats.all(email, { offset: "-7 days" });
  return { recent, stats };
}

/**
 * Get global delivery health stats.
 */
export function getGlobalDeliveryStats(days = 7) {
  if (!stmts) ensureTable();
  const offset = `-${Math.min(Math.max(days, 1), 90)} days`;
  return stmts.getGlobalStats.all({ offset });
}

/**
 * Purge old delivery logs.
 */
export function purgeDeliveryLogs(days = 30) {
  if (!stmts) ensureTable();
  return stmts.purge.run(`-${Math.max(days, 7)} days`);
}
