/**
 * Structured error/event logger backed by SQLite.
 * Captures source, category, level, message, and optional stack trace.
 * Provides query API for post-mortems and error trend analysis.
 */

import { getDb } from "../subscribers/db.js";

let stmts = null;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'error',
      source TEXT NOT NULL,
      category TEXT,
      message TEXT NOT NULL,
      stack TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_errlog_source ON error_log(source);
    CREATE INDEX IF NOT EXISTS idx_errlog_created ON error_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_errlog_level ON error_log(level);
  `);

  stmts = {
    insert: db.prepare(`
      INSERT INTO error_log (level, source, category, message, stack, metadata)
      VALUES (@level, @source, @category, @message, @stack, @metadata)
    `),
    query: null, // built dynamically
    trends: null,
    purge: db.prepare("DELETE FROM error_log WHERE created_at < datetime('now', ?)")
  };
}

/**
 * Log a structured error/warning/info event.
 */
export function logEvent({ level = "error", source, category = null, message, stack = null, metadata = null }) {
  if (!stmts) ensureTable();
  try {
    stmts.insert.run({
      level,
      source: source || "unknown",
      category: category || null,
      message: String(message).slice(0, 2000),
      stack: stack ? String(stack).slice(0, 4000) : null,
      metadata: metadata ? JSON.stringify(metadata) : null
    });
  } catch {
    // Don't let logging failures crash the app
  }
}

/** Convenience wrappers */
export function logError(source, message, opts = {}) {
  logEvent({ level: "error", source, message, ...opts });
}

export function logWarn(source, message, opts = {}) {
  logEvent({ level: "warn", source, message, ...opts });
}

export function logInfo(source, message, opts = {}) {
  logEvent({ level: "info", source, message, ...opts });
}

/**
 * Query error logs with optional filters.
 * @param {object} filters - { source, level, category, days, limit, offset }
 * @returns {object} { logs: [], total: number }
 */
export function queryLogs(filters = {}) {
  if (!stmts) ensureTable();
  const db = getDb();

  const where = [];
  const params = {};

  if (filters.source) {
    where.push("source = @source");
    params.source = filters.source;
  }
  if (filters.level) {
    where.push("level = @level");
    params.level = filters.level;
  }
  if (filters.category) {
    where.push("category = @category");
    params.category = filters.category;
  }
  if (filters.days) {
    where.push("created_at >= datetime('now', @daysOffset)");
    params.daysOffset = `-${Math.min(Math.max(Number(filters.days) || 7, 1), 90)} days`;
  }

  const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM error_log ${whereClause}`).get(params).cnt;
  const logs = db.prepare(`SELECT * FROM error_log ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`).all(params);

  return { logs, total };
}

/**
 * Get error trends: count by source and level, bucketed by hour/day.
 * @param {number} days - Lookback period (default 7)
 * @returns {object} { bySource, byLevel, hourly }
 */
export function getErrorTrends(days = 7) {
  if (!stmts) ensureTable();
  const db = getDb();

  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const bySource = db.prepare(`
    SELECT source, COUNT(*) as count FROM error_log
    WHERE created_at >= datetime('now', ?) AND level = 'error'
    GROUP BY source ORDER BY count DESC LIMIT 20
  `).all(daysOffset);

  const byLevel = db.prepare(`
    SELECT level, COUNT(*) as count FROM error_log
    WHERE created_at >= datetime('now', ?)
    GROUP BY level ORDER BY count DESC
  `).all(daysOffset);

  const daily = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count FROM error_log
    WHERE created_at >= datetime('now', ?) AND level = 'error'
    GROUP BY day ORDER BY day ASC
  `).all(daysOffset);

  return { bySource, byLevel, daily };
}

/**
 * Purge old logs beyond retention period.
 * @param {number} days - Keep logs newer than this (default 30)
 */
export function purgeLogs(days = 30) {
  if (!stmts) ensureTable();
  return stmts.purge.run(`-${Math.max(days, 1)} days`);
}
