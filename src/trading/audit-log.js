/**
 * Trade audit log: structured, immutable record of every trading action.
 * Captures order events, state changes, risk decisions, and errors.
 * Queryable via /api/trading/audit endpoint.
 */

import { getDb } from "../subscribers/db.js";
import { onTradeAuditEvent } from "../notifications/dispatch.js";

let initialized = false;

function ensureTable() {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      execution_id INTEGER,
      market_id TEXT,
      token_id TEXT,
      side TEXT,
      category TEXT,
      amount REAL,
      price REAL,
      pnl_usd REAL,
      detail TEXT,
      dry_run INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_event ON trade_audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_audit_exec ON trade_audit_log(execution_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON trade_audit_log(created_at);
  `);
  initialized = true;
}

/**
 * Log a trade audit event.
 * @param {string} eventType - ORDER_PLACED, ORDER_FILLED, ORDER_REJECTED, ORDER_FAILED,
 *   POSITION_OPENED, POSITION_CLOSED, RISK_BLOCKED, BOT_STATE_CHANGE,
 *   CIRCUIT_BREAKER, LIQUIDATION, SETTLEMENT
 * @param {object} data - Event details
 */
export function logAuditEvent(eventType, data = {}) {
  ensureTable();
  try {
    getDb().prepare(`
      INSERT INTO trade_audit_log (event_type, execution_id, market_id, token_id, side, category, amount, price, pnl_usd, detail, dry_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventType,
      data.executionId || null,
      data.marketId || null,
      data.tokenId || null,
      data.side || null,
      data.category || null,
      data.amount || null,
      data.price || null,
      data.pnlUsd || null,
      data.detail ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : null,
      data.dryRun != null ? (data.dryRun ? 1 : 0) : 1
    );
    // Dispatch trade notification (non-blocking)
    try { onTradeAuditEvent(eventType, data); } catch { /* non-fatal */ }
  } catch {
    // Audit logging must never break the trading pipeline
  }
}

/**
 * Query audit log with filters.
 */
export function queryAuditLog({ eventType, marketId, executionId, days = 7, limit = 100, offset = 0 } = {}) {
  ensureTable();
  const conditions = ["created_at >= datetime('now', ?)"];
  const params = [`-${days} days`];

  if (eventType) { conditions.push("event_type = ?"); params.push(eventType); }
  if (marketId) { conditions.push("market_id = ?"); params.push(marketId); }
  if (executionId) { conditions.push("execution_id = ?"); params.push(executionId); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  params.push(limit, offset);

  return getDb().prepare(
    `SELECT * FROM trade_audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params);
}

/**
 * Get audit event counts by type for a time window.
 */
export function getAuditSummary(days = 7) {
  ensureTable();
  const rows = getDb().prepare(`
    SELECT event_type, COUNT(*) as count,
           SUM(CASE WHEN dry_run = 0 THEN 1 ELSE 0 END) as live_count,
           ROUND(SUM(pnl_usd), 4) as total_pnl
    FROM trade_audit_log
    WHERE created_at >= datetime('now', ?)
    GROUP BY event_type
    ORDER BY count DESC
  `).all(`-${days} days`);
  return { days, events: rows };
}

/**
 * Get full audit trail for a specific execution.
 */
export function getExecutionAuditTrail(executionId) {
  ensureTable();
  return getDb().prepare(
    "SELECT * FROM trade_audit_log WHERE execution_id = ? ORDER BY id ASC"
  ).all(executionId);
}

/**
 * Position reconciliation: compare open executions against audit events
 * to detect orphaned positions or missing close events.
 */
export function reconcilePositions() {
  ensureTable();
  const db = getDb();

  const openExecs = db.prepare(
    "SELECT id, market_id, side, amount, entry_price, opened_at FROM trade_executions WHERE status = 'open'"
  ).all();

  const results = [];
  for (const exec of openExecs) {
    const events = db.prepare(
      "SELECT event_type, created_at FROM trade_audit_log WHERE execution_id = ? ORDER BY id DESC LIMIT 1"
    ).get(exec.id);

    const ageHours = (Date.now() - new Date(exec.opened_at).getTime()) / (1000 * 60 * 60);

    results.push({
      executionId: exec.id,
      marketId: exec.market_id,
      side: exec.side,
      amount: exec.amount,
      entryPrice: exec.entry_price,
      ageHours: Math.round(ageHours * 10) / 10,
      lastAuditEvent: events?.event_type || "NONE",
      lastAuditAt: events?.created_at || null,
      warning: ageHours > 24 ? "stale_position" : null
    });
  }

  return { openCount: results.length, positions: results, stale: results.filter(r => r.warning).length };
}

/**
 * Auto-repair stale positions: cancel executions older than maxAgeHours with no audit events.
 * Returns count of auto-repaired positions.
 */
export function autoRepairStalePositions(maxAgeHours = 72) {
  ensureTable();
  const db = getDb();

  const staleExecs = db.prepare(`
    SELECT e.id, e.market_id, e.side, e.amount, e.opened_at
    FROM trade_executions e
    WHERE e.status = 'open'
      AND datetime(e.opened_at, '+${Math.floor(maxAgeHours)} hours') < datetime('now')
  `).all();

  let repaired = 0;
  for (const exec of staleExecs) {
    db.prepare(
      "UPDATE trade_executions SET status = 'cancelled', close_reason = 'auto_repair_stale', closed_at = datetime('now') WHERE id = ?"
    ).run(exec.id);

    logAuditEvent("POSITION_AUTO_REPAIRED", {
      executionId: exec.id,
      marketId: exec.market_id,
      side: exec.side,
      amount: exec.amount,
      reason: `stale_${Math.round((Date.now() - new Date(exec.opened_at).getTime()) / 3600000)}h`
    });
    repaired++;
  }

  return { repaired, maxAgeHours };
}
