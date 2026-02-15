/**
 * Signal history database — logs every signal, tracks outcomes.
 * Uses the same better-sqlite3 DB as subscribers.
 */

import { getDb } from "../subscribers/db.js";

let stmts = null;

function ensureTable() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      question TEXT,
      category TEXT,
      signal TEXT NOT NULL,
      side TEXT,
      strength TEXT,
      phase TEXT,
      regime TEXT,
      model_up REAL,
      model_down REAL,
      market_yes REAL,
      market_no REAL,
      edge REAL,
      rsi REAL,
      orderbook_imbalance REAL,
      settlement_left_min REAL,
      liquidity REAL,
      created_at TEXT DEFAULT (datetime('now')),
      -- Outcome fields (filled after settlement)
      outcome TEXT,
      outcome_price_yes REAL,
      outcome_price_no REAL,
      settled_at TEXT,
      pnl_pct REAL
    );

    CREATE INDEX IF NOT EXISTS idx_signal_market ON signal_history(market_id);
    CREATE INDEX IF NOT EXISTS idx_signal_created ON signal_history(created_at);
    CREATE INDEX IF NOT EXISTS idx_signal_signal ON signal_history(signal);
    CREATE INDEX IF NOT EXISTS idx_signal_outcome ON signal_history(outcome);
  `);

  stmts = {
    insert: db.prepare(`
      INSERT INTO signal_history (
        market_id, question, category, signal, side, strength, phase, regime,
        model_up, model_down, market_yes, market_no, edge, rsi,
        orderbook_imbalance, settlement_left_min, liquidity
      ) VALUES (
        @market_id, @question, @category, @signal, @side, @strength, @phase, @regime,
        @model_up, @model_down, @market_yes, @market_no, @edge, @rsi,
        @orderbook_imbalance, @settlement_left_min, @liquidity
      )
    `),

    recordOutcome: db.prepare(`
      UPDATE signal_history
      SET outcome = @outcome,
          outcome_price_yes = @outcome_price_yes,
          outcome_price_no = @outcome_price_no,
          settled_at = datetime('now'),
          pnl_pct = @pnl_pct
      WHERE id = @id
    `),

    getUnsettled: db.prepare(`
      SELECT id, market_id, side, edge, market_yes, market_no
      FROM signal_history
      WHERE signal != 'NO TRADE' AND outcome IS NULL AND settled_at IS NULL
      ORDER BY created_at DESC
    `),

    getRecent: db.prepare(`
      SELECT * FROM signal_history
      WHERE signal != 'NO TRADE'
      ORDER BY created_at DESC
      LIMIT @limit
    `),

    getStats: db.prepare(`
      SELECT
        COUNT(*) as total_signals,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN outcome IS NULL AND signal != 'NO TRADE' THEN 1 ELSE 0 END) as pending,
        AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl,
        AVG(CASE WHEN outcome = 'WIN' THEN pnl_pct END) as avg_win_pnl,
        AVG(CASE WHEN outcome = 'LOSS' THEN pnl_pct END) as avg_loss_pnl,
        AVG(edge) as avg_edge
      FROM signal_history
      WHERE signal != 'NO TRADE'
    `),

    getStatsByCategory: db.prepare(`
      SELECT
        category,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
        AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl
      FROM signal_history
      WHERE signal != 'NO TRADE'
      GROUP BY category
    `),

    getStatsByStrength: db.prepare(`
      SELECT
        strength,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
        AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl
      FROM signal_history
      WHERE signal != 'NO TRADE'
      GROUP BY strength
    `)
  };
}

/**
 * Log a signal from a tick.
 */
export function logSignal(tick) {
  if (!stmts) ensureTable();

  const isEnter = tick.rec?.action === "ENTER";
  const side = tick.rec?.side || null;
  const bestEdge = side === "UP" ? tick.edge?.edgeUp : tick.edge?.edgeDown;

  return stmts.insert.run({
    market_id: tick.marketId || "unknown",
    question: tick.question || null,
    category: tick.category || null,
    signal: tick.signal || "NO TRADE",
    side: side,
    strength: tick.rec?.strength || null,
    phase: tick.rec?.phase || null,
    regime: tick.regimeInfo?.regime || null,
    model_up: tick.timeAware?.adjustedUp ?? null,
    model_down: tick.timeAware?.adjustedDown ?? null,
    market_yes: tick.prices?.up ?? null,
    market_no: tick.prices?.down ?? null,
    edge: bestEdge ?? null,
    rsi: tick.indicators?.rsi ?? null,
    orderbook_imbalance: tick.orderbookImbalance ?? null,
    settlement_left_min: tick.settlementLeftMin ?? null,
    liquidity: tick.market?.liquidity ?? null
  });
}

/**
 * Record outcome for a settled signal.
 * outcome: "WIN" | "LOSS"
 */
export function recordOutcome({ id, outcome, outcomeYes, outcomeNo, pnlPct }) {
  if (!stmts) ensureTable();

  return stmts.recordOutcome.run({
    id,
    outcome,
    outcome_price_yes: outcomeYes ?? null,
    outcome_price_no: outcomeNo ?? null,
    pnl_pct: pnlPct ?? null
  });
}

/**
 * Get signals that haven't been settled yet (for outcome tracking).
 */
export function getUnsettledSignals() {
  if (!stmts) ensureTable();
  return stmts.getUnsettled.all();
}

/**
 * Get recent signals (for dashboard display).
 */
export function getRecentSignals(limit = 50) {
  if (!stmts) ensureTable();
  return stmts.getRecent.all({ limit });
}

/**
 * Get aggregate stats.
 */
export function getSignalStats() {
  if (!stmts) ensureTable();

  const overall = stmts.getStats.get();
  const byCategory = stmts.getStatsByCategory.all();
  const byStrength = stmts.getStatsByStrength.all();

  const winRate = overall.wins + overall.losses > 0
    ? (overall.wins / (overall.wins + overall.losses) * 100).toFixed(1)
    : null;

  return {
    ...overall,
    winRate,
    byCategory,
    byStrength
  };
}

/**
 * Initialize the signal history table.
 */
export function initSignalHistory() {
  ensureTable();
}
