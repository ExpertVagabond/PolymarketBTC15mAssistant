/**
 * Trade execution log: persistent SQLite record of every trade (live + dry-run).
 * Replaces CSV-only logging with queryable database.
 */

import { getDb } from "../subscribers/db.js";

let stmts = null;

function ensureTable() {
  if (stmts) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT,
      market_id TEXT NOT NULL,
      token_id TEXT,
      question TEXT,
      category TEXT,
      side TEXT NOT NULL,
      strength TEXT,
      amount REAL NOT NULL,
      entry_price REAL,
      fill_price REAL,
      exit_price REAL,
      pnl_usd REAL,
      pnl_pct REAL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed', 'cancelled', 'failed')),
      close_reason TEXT,
      dry_run INTEGER DEFAULT 1,
      order_id TEXT,
      edge REAL,
      confidence INTEGER,
      liquidity_check TEXT,
      error TEXT,
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trade_exec_status ON trade_executions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_exec_market ON trade_executions(market_id);
    CREATE INDEX IF NOT EXISTS idx_trade_exec_opened ON trade_executions(opened_at);
  `);

  stmts = {
    insert: db.prepare(`
      INSERT INTO trade_executions (
        signal_id, market_id, token_id, question, category, side, strength,
        amount, entry_price, fill_price, status, dry_run, order_id, edge,
        confidence, liquidity_check, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    close: db.prepare(`
      UPDATE trade_executions
      SET status = 'closed', exit_price = ?, pnl_usd = ?, pnl_pct = ?,
          close_reason = ?, closed_at = datetime('now')
      WHERE id = ?
    `),
    fail: db.prepare(`
      UPDATE trade_executions
      SET status = 'failed', error = ?, closed_at = datetime('now')
      WHERE id = ?
    `),
    getOpen: db.prepare("SELECT * FROM trade_executions WHERE status = 'open' ORDER BY opened_at DESC"),
    getRecent: db.prepare("SELECT * FROM trade_executions ORDER BY opened_at DESC LIMIT ?"),
    getById: db.prepare("SELECT * FROM trade_executions WHERE id = ?"),
    getBySignalId: db.prepare("SELECT * FROM trade_executions WHERE signal_id = ?"),
    countOpen: db.prepare("SELECT COUNT(*) as count FROM trade_executions WHERE status = 'open'"),
    stats: db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
        SUM(CASE WHEN dry_run = 1 THEN 1 ELSE 0 END) as dry_runs,
        SUM(CASE WHEN dry_run = 0 THEN 1 ELSE 0 END) as live_trades,
        SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(pnl_usd), 4) as total_pnl,
        ROUND(AVG(pnl_pct), 2) as avg_pnl_pct
      FROM trade_executions
    `)
  };
}

/**
 * Log a new trade execution.
 * @returns {number} The trade execution ID
 */
export function logExecution({
  signalId, marketId, tokenId, question, category, side, strength,
  amount, entryPrice, fillPrice, status = "open", dryRun = true,
  orderId, edge, confidence, liquidityCheck, error
}) {
  ensureTable();
  const info = stmts.insert.run(
    signalId || null, marketId, tokenId || null, question || null,
    category || null, side, strength || null, amount, entryPrice || null,
    fillPrice || null, status, dryRun ? 1 : 0, orderId || null,
    edge || null, confidence || null,
    liquidityCheck ? JSON.stringify(liquidityCheck) : null,
    error || null
  );
  return info.lastInsertRowid;
}

/**
 * Close an execution (TP, SL, settlement).
 */
export function closeExecution(executionId, { exitPrice, pnlUsd, pnlPct, closeReason }) {
  ensureTable();
  stmts.close.run(exitPrice, pnlUsd, pnlPct, closeReason, executionId);
}

/**
 * Mark an execution as failed.
 */
export function failExecution(executionId, error) {
  ensureTable();
  stmts.fail.run(error, executionId);
}

/**
 * Get all open executions.
 */
export function getOpenExecutions() {
  ensureTable();
  return stmts.getOpen.all();
}

/**
 * Get recent executions.
 */
export function getRecentExecutions(limit = 50) {
  ensureTable();
  return stmts.getRecent.all(limit);
}

/**
 * Get execution by ID.
 */
export function getExecutionById(id) {
  ensureTable();
  return stmts.getById.get(id);
}

/**
 * Get execution by signal ID.
 */
export function getExecutionBySignalId(signalId) {
  ensureTable();
  return stmts.getBySignalId.get(signalId);
}

/**
 * Get count of open positions (for risk manager sync on restart).
 */
export function getOpenCount() {
  ensureTable();
  return stmts.countOpen.get().count;
}

/**
 * Check if there's an open position on a given market.
 */
export function hasOpenPositionOnMarket(marketId) {
  ensureTable();
  const row = getDb().prepare(
    "SELECT id FROM trade_executions WHERE market_id = ? AND status = 'open' LIMIT 1"
  ).get(marketId);
  return !!row;
}

/**
 * Check if a trade was recently opened on a market (cooldown).
 * @param {string} marketId
 * @param {number} cooldownMinutes - minimum minutes between trades on same market
 */
export function isMarketOnCooldown(marketId, cooldownMinutes = 5) {
  ensureTable();
  const row = getDb().prepare(
    "SELECT id FROM trade_executions WHERE market_id = ? AND opened_at >= datetime('now', ?) ORDER BY opened_at DESC LIMIT 1"
  ).get(marketId, `-${cooldownMinutes} minutes`);
  return !!row;
}

/**
 * Get trade execution stats.
 */
export function getExecutionStats() {
  ensureTable();
  return stmts.stats.get();
}

/**
 * Force-cancel an open execution (admin action — marks as cancelled, no sell order).
 */
export function cancelExecution(executionId) {
  ensureTable();
  const exec = stmts.getById.get(executionId);
  if (!exec) return { error: "not_found" };
  if (exec.status !== "open") return { error: "not_open", status: exec.status };
  getDb().prepare(
    "UPDATE trade_executions SET status = 'cancelled', close_reason = 'admin_cancel', closed_at = datetime('now') WHERE id = ?"
  ).run(executionId);
  return { ok: true, id: executionId };
}

/**
 * Cancel all open executions (emergency liquidation — marks all as cancelled).
 */
export function cancelAllOpenExecutions() {
  ensureTable();
  const open = stmts.getOpen.all();
  const info = getDb().prepare(
    "UPDATE trade_executions SET status = 'cancelled', close_reason = 'admin_liquidate_all', closed_at = datetime('now') WHERE status = 'open'"
  ).run();
  return { ok: true, cancelled: info.changes, positions: open };
}
