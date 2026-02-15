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

  // Add decision context columns (safe: ALTER TABLE IF NOT EXISTS pattern)
  const cols = db.prepare("PRAGMA table_info(trade_executions)").all().map(c => c.name);
  if (!cols.includes("quality")) db.exec("ALTER TABLE trade_executions ADD COLUMN quality INTEGER");
  if (!cols.includes("regime")) db.exec("ALTER TABLE trade_executions ADD COLUMN regime TEXT");
  if (!cols.includes("streak_mult")) db.exec("ALTER TABLE trade_executions ADD COLUMN streak_mult REAL");
  if (!cols.includes("hour_mult")) db.exec("ALTER TABLE trade_executions ADD COLUMN hour_mult REAL");
  if (!cols.includes("sizing_method")) db.exec("ALTER TABLE trade_executions ADD COLUMN sizing_method TEXT");

  stmts = {
    insert: db.prepare(`
      INSERT INTO trade_executions (
        signal_id, market_id, token_id, question, category, side, strength,
        amount, entry_price, fill_price, status, dry_run, order_id, edge,
        confidence, liquidity_check, error, quality, regime, streak_mult, hour_mult, sizing_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  orderId, edge, confidence, liquidityCheck, error,
  quality, regime, streakMult, hourMult, sizingMethod
}) {
  ensureTable();
  const info = stmts.insert.run(
    signalId || null, marketId, tokenId || null, question || null,
    category || null, side, strength || null, amount, entryPrice || null,
    fillPrice || null, status, dryRun ? 1 : 0, orderId || null,
    edge || null, confidence || null,
    liquidityCheck ? JSON.stringify(liquidityCheck) : null,
    error || null,
    quality ?? null, regime || null, streakMult ?? null, hourMult ?? null, sizingMethod || null
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
 * Check if a new trade would be correlated with an existing open position.
 * Two markets are correlated if: same category AND question text overlap > 60%.
 * @param {string} category - Market category
 * @param {string} question - Market question text
 * @returns {{ correlated: boolean, matchedExecId: number|null, matchedQuestion: string|null }}
 */
export function isCorrelatedWithOpenPosition(category, question) {
  ensureTable();
  if (!category || !question) return { correlated: false, matchedExecId: null, matchedQuestion: null };

  const openInCategory = getDb().prepare(
    "SELECT id, question FROM trade_executions WHERE status = 'open' AND category = ?"
  ).all(category);

  if (openInCategory.length === 0) return { correlated: false, matchedExecId: null, matchedQuestion: null };

  // Token-based similarity: split into words, measure overlap
  const newTokens = new Set(question.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(t => t.length > 2));
  if (newTokens.size === 0) return { correlated: false, matchedExecId: null, matchedQuestion: null };

  for (const exec of openInCategory) {
    if (!exec.question) continue;
    const existTokens = new Set(exec.question.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(t => t.length > 2));
    if (existTokens.size === 0) continue;

    let overlap = 0;
    for (const t of newTokens) { if (existTokens.has(t)) overlap++; }
    const similarity = overlap / Math.min(newTokens.size, existTokens.size);

    if (similarity >= 0.6) {
      return { correlated: true, matchedExecId: exec.id, matchedQuestion: exec.question };
    }
  }

  return { correlated: false, matchedExecId: null, matchedQuestion: null };
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

/**
 * Get win rates grouped by hour-of-day (0-23 UTC).
 * Returns array of { hour, trades, wins, losses, winRate }.
 */
export function getHourlyWinRates() {
  ensureTable();
  return getDb().prepare(`
    SELECT
      CAST(strftime('%H', opened_at) AS INTEGER) as hour,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(
        CAST(SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) + SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END), 0) * 100,
        1
      ) as win_rate,
      ROUND(SUM(pnl_usd), 4) as total_pnl
    FROM trade_executions
    WHERE status = 'closed' AND pnl_usd IS NOT NULL
    GROUP BY CAST(strftime('%H', opened_at) AS INTEGER)
    ORDER BY hour
  `).all();
}

/**
 * Get win rate for a specific hour (0-23 UTC).
 * Returns { winRate, sampleSize } or null if insufficient data.
 */
export function getHourWinRate(hour) {
  ensureTable();
  const row = getDb().prepare(`
    SELECT
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses
    FROM trade_executions
    WHERE status = 'closed' AND pnl_usd IS NOT NULL
      AND CAST(strftime('%H', opened_at) AS INTEGER) = ?
  `).get(hour);
  if (!row) return null;
  const total = (row.wins || 0) + (row.losses || 0);
  if (total < 5) return null; // insufficient sample
  return { winRate: (row.wins / total) * 100, sampleSize: total };
}

/**
 * Get quality score distribution from stored quality column.
 */
export function getQualityDistribution() {
  ensureTable();
  const db = getDb();
  const dist = db.prepare(`
    SELECT
      CASE
        WHEN quality < 30 THEN '0-29'
        WHEN quality < 50 THEN '30-49'
        WHEN quality < 70 THEN '50-69'
        WHEN quality < 90 THEN '70-89'
        ELSE '90-100'
      END as bucket,
      COUNT(*) as count,
      ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses
    FROM trade_executions
    WHERE quality IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket
  `).all();

  const total = db.prepare("SELECT COUNT(*) as c FROM trade_executions").get().c;
  const withQuality = db.prepare("SELECT COUNT(*) as c FROM trade_executions WHERE quality IS NOT NULL").get().c;
  const avgQuality = db.prepare("SELECT ROUND(AVG(quality), 1) as avg FROM trade_executions WHERE quality IS NOT NULL").get()?.avg;

  // Quality → win rate correlation
  const qualityWinCorr = db.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN quality >= 70 THEN
        CASE WHEN pnl_usd > 0 THEN 1.0 ELSE 0.0 END
      END) * 100, 1) as high_quality_win_rate,
      ROUND(AVG(CASE WHEN quality < 50 THEN
        CASE WHEN pnl_usd > 0 THEN 1.0 ELSE 0.0 END
      END) * 100, 1) as low_quality_win_rate
    FROM trade_executions
    WHERE quality IS NOT NULL AND status = 'closed' AND pnl_usd IS NOT NULL
  `).get();

  return {
    total, withQuality, avgQuality,
    distribution: dist,
    correlation: qualityWinCorr
  };
}

/**
 * Get detailed trade performance analytics.
 */
export function getTradeAnalytics() {
  ensureTable();
  const db = getDb();

  // Overall stats
  const overall = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN pnl_usd = 0 AND status = 'closed' THEN 1 ELSE 0 END) as breakeven,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(CASE WHEN pnl_usd IS NOT NULL THEN pnl_pct END), 2) as avg_pnl_pct,
      ROUND(AVG(CASE WHEN pnl_usd > 0 THEN pnl_usd END), 4) as avg_win,
      ROUND(AVG(CASE WHEN pnl_usd < 0 THEN pnl_usd END), 4) as avg_loss,
      MAX(pnl_usd) as best_trade,
      MIN(pnl_usd) as worst_trade,
      SUM(CASE WHEN dry_run = 0 THEN 1 ELSE 0 END) as live_trades,
      SUM(CASE WHEN dry_run = 1 THEN 1 ELSE 0 END) as dry_runs
    FROM trade_executions
  `).get();

  // Win rate
  const settled = (overall.wins || 0) + (overall.losses || 0);
  overall.win_rate = settled > 0 ? Math.round((overall.wins / settled) * 100) : null;

  // By category
  const byCategory = db.prepare(`
    SELECT
      COALESCE(category, 'other') as category,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(pnl_pct), 2) as avg_pnl_pct
    FROM trade_executions WHERE status = 'closed'
    GROUP BY COALESCE(category, 'other')
    ORDER BY total_pnl DESC
  `).all();

  // By day (last 30 days)
  const byDay = db.prepare(`
    SELECT
      DATE(opened_at) as day,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(pnl_usd), 4) as pnl
    FROM trade_executions
    WHERE opened_at >= datetime('now', '-30 days') AND status = 'closed'
    GROUP BY DATE(opened_at)
    ORDER BY day DESC
  `).all();

  // Avg hold time (in minutes) for closed trades
  const holdTime = db.prepare(`
    SELECT ROUND(AVG(
      (julianday(closed_at) - julianday(opened_at)) * 24 * 60
    ), 1) as avg_hold_minutes
    FROM trade_executions
    WHERE status = 'closed' AND closed_at IS NOT NULL
  `).get();

  // By close reason
  const byCloseReason = db.prepare(`
    SELECT
      COALESCE(close_reason, 'unknown') as reason,
      COUNT(*) as count,
      ROUND(SUM(pnl_usd), 4) as total_pnl
    FROM trade_executions WHERE status = 'closed'
    GROUP BY close_reason
    ORDER BY count DESC
  `).all();

  // Edge accuracy: compare predicted edge to actual P&L %
  const edgeAccuracy = db.prepare(`
    SELECT
      ROUND(AVG(edge * 100), 2) as avg_predicted_edge_pct,
      ROUND(AVG(pnl_pct), 2) as avg_actual_pnl_pct,
      COUNT(*) as sample_size
    FROM trade_executions
    WHERE status = 'closed' AND edge IS NOT NULL AND pnl_pct IS NOT NULL
  `).get();

  // By regime (from decision context)
  const byRegime = db.prepare(`
    SELECT
      COALESCE(regime, 'unknown') as regime,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(pnl_usd), 4) as total_pnl
    FROM trade_executions WHERE status = 'closed'
    GROUP BY regime
    ORDER BY trades DESC
  `).all();

  // By sizing method
  const bySizingMethod = db.prepare(`
    SELECT
      COALESCE(sizing_method, 'unknown') as method,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(amount), 2) as avg_size
    FROM trade_executions WHERE status = 'closed'
    GROUP BY sizing_method
    ORDER BY trades DESC
  `).all();

  return {
    overall,
    byCategory,
    byDay,
    avgHoldMinutes: holdTime?.avg_hold_minutes || null,
    byCloseReason,
    edgeAccuracy,
    byRegime,
    bySizingMethod
  };
}

/**
 * Export trade executions with full decision context.
 * @param {{ days?: number, status?: string, limit?: number }} opts
 * @returns {object[]}
 */
export function exportExecutions({ days = 30, status, limit = 1000 } = {}) {
  ensureTable();
  const conditions = ["opened_at >= datetime('now', ?)"];
  const params = [`-${days} days`];
  if (status) { conditions.push("status = ?"); params.push(status); }
  params.push(Math.min(limit, 5000));

  return getDb().prepare(`
    SELECT
      id, signal_id, market_id, question, category, side, strength,
      amount, entry_price, fill_price, exit_price, pnl_usd, pnl_pct,
      status, close_reason, dry_run, edge, confidence,
      quality, regime, streak_mult, hour_mult, sizing_method,
      opened_at, closed_at
    FROM trade_executions
    WHERE ${conditions.join(" AND ")}
    ORDER BY opened_at DESC
    LIMIT ?
  `).all(...params);
}

/**
 * Get daily trade summary for a specific date (YYYY-MM-DD, defaults to today UTC).
 */
export function getDailySummary(date) {
  ensureTable();
  const db = getDb();
  const d = date || new Date().toISOString().slice(0, 10);

  const overview = db.prepare(`
    SELECT
      COUNT(*) as trades,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
      ROUND(SUM(amount), 2) as total_wagered,
      ROUND(AVG(quality), 1) as avg_quality,
      MAX(pnl_usd) as best_trade_pnl,
      MIN(pnl_usd) as worst_trade_pnl,
      SUM(CASE WHEN dry_run = 1 THEN 1 ELSE 0 END) as dry_runs,
      SUM(CASE WHEN dry_run = 0 THEN 1 ELSE 0 END) as live_trades
    FROM trade_executions
    WHERE DATE(opened_at) = ?
  `).get(d);

  const settled = (overview.wins || 0) + (overview.losses || 0);
  overview.win_rate = settled > 0 ? Math.round((overview.wins / settled) * 100) : null;

  const byCategory = db.prepare(`
    SELECT
      COALESCE(category, 'other') as category,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_usd), 4) as pnl
    FROM trade_executions
    WHERE DATE(opened_at) = ? AND status = 'closed'
    GROUP BY category ORDER BY pnl DESC
  `).all(d);

  const byRegime = db.prepare(`
    SELECT
      COALESCE(regime, 'unknown') as regime,
      COUNT(*) as trades,
      ROUND(SUM(pnl_usd), 4) as pnl
    FROM trade_executions
    WHERE DATE(opened_at) = ?
    GROUP BY regime ORDER BY trades DESC
  `).all(d);

  const bySide = db.prepare(`
    SELECT
      side, COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_usd), 4) as pnl
    FROM trade_executions
    WHERE DATE(opened_at) = ? AND status = 'closed'
    GROUP BY side
  `).all(d);

  return { date: d, overview, byCategory, byRegime, bySide };
}

/**
 * P&L attribution: break down performance by each decision factor.
 * Uses the decision context columns added in Tier 24.
 */
export function getPerformanceAttribution(days = 30) {
  ensureTable();
  const db = getDb();
  const daysParam = `-${days} days`;

  // By quality tier
  const byQuality = db.prepare(`
    SELECT
      CASE
        WHEN quality < 30 THEN '0-29'
        WHEN quality < 50 THEN '30-49'
        WHEN quality < 70 THEN '50-69'
        ELSE '70+'
      END as tier,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(pnl_pct), 2) as avg_pnl_pct
    FROM trade_executions
    WHERE status = 'closed' AND quality IS NOT NULL AND opened_at >= datetime('now', ?)
    GROUP BY tier ORDER BY tier
  `).all(daysParam);

  // By regime
  const byRegime = db.prepare(`
    SELECT
      COALESCE(regime, 'unknown') as regime,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(pnl_pct), 2) as avg_pnl_pct
    FROM trade_executions
    WHERE status = 'closed' AND opened_at >= datetime('now', ?)
    GROUP BY regime ORDER BY total_pnl DESC
  `).all(daysParam);

  // By hour of day
  const byHour = db.prepare(`
    SELECT
      CAST(strftime('%H', opened_at) AS INTEGER) as hour,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_usd), 4) as total_pnl
    FROM trade_executions
    WHERE status = 'closed' AND pnl_usd IS NOT NULL AND opened_at >= datetime('now', ?)
    GROUP BY hour ORDER BY hour
  `).all(daysParam);

  // By sizing method
  const bySizing = db.prepare(`
    SELECT
      COALESCE(sizing_method, 'unknown') as method,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(amount), 2) as avg_size
    FROM trade_executions
    WHERE status = 'closed' AND opened_at >= datetime('now', ?)
    GROUP BY sizing_method ORDER BY total_pnl DESC
  `).all(daysParam);

  // By strength
  const byStrength = db.prepare(`
    SELECT
      COALESCE(strength, 'unknown') as strength,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(pnl_pct), 2) as avg_pnl_pct
    FROM trade_executions
    WHERE status = 'closed' AND opened_at >= datetime('now', ?)
    GROUP BY strength ORDER BY total_pnl DESC
  `).all(daysParam);

  // By category
  const byCategory = db.prepare(`
    SELECT
      COALESCE(category, 'other') as category,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(quality), 1) as avg_quality
    FROM trade_executions
    WHERE status = 'closed' AND opened_at >= datetime('now', ?)
    GROUP BY category ORDER BY total_pnl DESC
  `).all(daysParam);

  // Add win rates
  const addWinRate = (rows) => rows.map(r => ({
    ...r,
    win_rate: (r.wins + (r.losses || 0)) > 0
      ? Math.round((r.wins / (r.wins + (r.losses || (r.trades - r.wins)))) * 100)
      : null
  }));

  return {
    days,
    byQuality: addWinRate(byQuality),
    byRegime: addWinRate(byRegime),
    byHour,
    bySizing: addWinRate(bySizing),
    byStrength: addWinRate(byStrength),
    byCategory: addWinRate(byCategory)
  };
}

/**
 * Confidence calibration: bucket trades by confidence decile,
 * compare predicted confidence to actual win rate.
 * Flags buckets where actual win rate deviates >15% from expected.
 */
export function getConfidenceCalibration() {
  ensureTable();
  const db = getDb();

  const buckets = db.prepare(`
    SELECT
      CAST(confidence / 10 AS INTEGER) * 10 as bucket_start,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(pnl_usd), 4) as total_pnl,
      ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
      ROUND(AVG(edge), 4) as avg_edge,
      ROUND(AVG(quality), 1) as avg_quality
    FROM trade_executions
    WHERE status = 'closed' AND confidence IS NOT NULL AND pnl_usd IS NOT NULL
    GROUP BY CAST(confidence / 10 AS INTEGER)
    ORDER BY bucket_start
  `).all();

  const calibration = buckets.map(b => {
    const settled = (b.wins || 0) + (b.losses || 0);
    const actualWinRate = settled > 0 ? Math.round((b.wins / settled) * 100) : null;
    // Expected win rate: confidence/100 (ideally, 70 confidence = 70% win rate)
    const expectedWinRate = b.bucket_start + 5; // midpoint of bucket
    const deviation = actualWinRate != null ? actualWinRate - expectedWinRate : null;
    const miscalibrated = deviation != null && Math.abs(deviation) > 15 && settled >= 5;

    return {
      bucket: `${b.bucket_start}-${b.bucket_start + 9}`,
      trades: b.trades,
      wins: b.wins,
      losses: b.losses,
      actualWinRate,
      expectedWinRate,
      deviation,
      miscalibrated,
      totalPnl: b.total_pnl,
      avgEdge: b.avg_edge,
      avgQuality: b.avg_quality
    };
  });

  const miscalibratedBuckets = calibration.filter(b => b.miscalibrated);
  const overconfident = miscalibratedBuckets.filter(b => b.deviation < -15);
  const underconfident = miscalibratedBuckets.filter(b => b.deviation > 15);

  return {
    buckets: calibration,
    summary: {
      totalBuckets: calibration.length,
      miscalibrated: miscalibratedBuckets.length,
      overconfident: overconfident.map(b => b.bucket),
      underconfident: underconfident.map(b => b.bucket)
    }
  };
}
