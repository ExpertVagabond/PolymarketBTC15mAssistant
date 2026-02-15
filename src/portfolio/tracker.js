/**
 * Virtual portfolio tracker — tracks hypothetical positions from signals.
 * Auto-opens positions when ENTER signals fire, closes on settlement.
 * All positions are virtual (paper trading) — no real money involved.
 */

import { getDb } from "../subscribers/db.js";

let stmts = null;

function ensureTable() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      question TEXT,
      category TEXT,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      current_price REAL,
      bet_pct REAL NOT NULL,
      confidence INTEGER,
      edge_at_entry REAL,
      status TEXT NOT NULL DEFAULT 'open',
      pnl_pct REAL,
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT,
      close_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_status ON portfolio_positions(status);
    CREATE INDEX IF NOT EXISTS idx_portfolio_market ON portfolio_positions(market_id);
  `);

  stmts = {
    open: db.prepare(`
      INSERT INTO portfolio_positions (market_id, question, category, side, entry_price, current_price, bet_pct, confidence, edge_at_entry)
      VALUES (@market_id, @question, @category, @side, @entry_price, @current_price, @bet_pct, @confidence, @edge_at_entry)
    `),

    updatePrice: db.prepare(`
      UPDATE portfolio_positions SET current_price = @current_price WHERE id = @id
    `),

    close: db.prepare(`
      UPDATE portfolio_positions
      SET status = 'closed', current_price = @current_price, pnl_pct = @pnl_pct, closed_at = datetime('now'), close_reason = @close_reason
      WHERE id = @id
    `),

    getOpen: db.prepare(`SELECT * FROM portfolio_positions WHERE status = 'open' ORDER BY opened_at DESC`),

    getRecent: db.prepare(`SELECT * FROM portfolio_positions ORDER BY opened_at DESC LIMIT @limit`),

    getSummary: db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_count,
        COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_count,
        SUM(CASE WHEN status = 'open' THEN bet_pct ELSE 0 END) as total_exposure,
        SUM(CASE WHEN status = 'closed' AND pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'closed' AND pnl_pct <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN status = 'closed' THEN pnl_pct ELSE 0 END) as realized_pnl,
        AVG(CASE WHEN status = 'closed' THEN pnl_pct END) as avg_pnl,
        MAX(CASE WHEN status = 'closed' THEN pnl_pct END) as best_trade,
        MIN(CASE WHEN status = 'closed' THEN pnl_pct END) as worst_trade
      FROM portfolio_positions
    `),

    getByMarket: db.prepare(`SELECT * FROM portfolio_positions WHERE market_id = @market_id AND status = 'open' LIMIT 1`),

    getCategorySummary: db.prepare(`
      SELECT
        category,
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_count,
        SUM(CASE WHEN status = 'open' THEN bet_pct ELSE 0 END) as exposure,
        SUM(CASE WHEN status = 'closed' THEN pnl_pct ELSE 0 END) as realized_pnl
      FROM portfolio_positions
      GROUP BY category
    `)
  };
}

/**
 * Open a virtual position from a signal tick.
 * Skips if we already have an open position in this market.
 */
export function openPosition(tick) {
  if (!stmts) ensureTable();

  const marketId = tick.marketId || tick.market?.conditionId;
  if (!marketId) return null;

  // Check for existing open position
  const existing = stmts.getByMarket.get({ market_id: marketId });
  if (existing) return null; // Already have a position

  const side = tick.rec?.side || "UP";
  const isYes = side === "UP";
  const entryPrice = isYes ? (tick.prices?.up ?? 0.5) : (tick.prices?.down ?? 0.5);
  const betPct = tick.kelly?.betPct ?? 0.01;
  const bestEdge = isYes ? tick.edge?.edgeUp : tick.edge?.edgeDown;

  return stmts.open.run({
    market_id: marketId,
    question: tick.question || tick.market?.question || "Unknown",
    category: tick.category || "other",
    side,
    entry_price: entryPrice,
    current_price: entryPrice,
    bet_pct: betPct,
    confidence: tick.confidence ?? null,
    edge_at_entry: bestEdge ?? null
  });
}

/**
 * Update current prices for all open positions.
 * Called with the scanner state map.
 */
export function updatePrices(scannerState) {
  if (!stmts) ensureTable();

  const openPositions = stmts.getOpen.all();
  for (const pos of openPositions) {
    const entry = scannerState[pos.market_id];
    if (!entry?.lastTick) continue;

    const tick = entry.lastTick;
    const isYes = pos.side === "UP";
    const currentPrice = isYes ? (tick.prices?.up ?? pos.current_price) : (tick.prices?.down ?? pos.current_price);

    stmts.updatePrice.run({ id: pos.id, current_price: currentPrice });
  }
}

/**
 * Close a position.
 */
export function closePosition(positionId, currentPrice, reason = "settled") {
  if (!stmts) ensureTable();

  const pos = stmts.getOpen.all().find(p => p.id === positionId);
  if (!pos) return null;

  // P&L: (exit - entry) / entry for YES side, inverted for NO
  const pnlPct = pos.entry_price > 0
    ? ((currentPrice - pos.entry_price) / pos.entry_price) * pos.bet_pct * 100
    : 0;

  return stmts.close.run({
    id: positionId,
    current_price: currentPrice,
    pnl_pct: Math.round(pnlPct * 100) / 100,
    close_reason: reason
  });
}

/**
 * Auto-close positions for settled markets.
 */
export function checkSettlements(scannerState) {
  if (!stmts) ensureTable();

  const openPositions = stmts.getOpen.all();
  for (const pos of openPositions) {
    const entry = scannerState[pos.market_id];
    if (!entry?.lastTick) continue;

    const tick = entry.lastTick;
    const remaining = tick.settlementLeftMin ?? tick.market?.settlementLeftMin;

    // Close if market is near settlement
    if (remaining != null && remaining <= 0) {
      const isYes = pos.side === "UP";
      const finalPrice = isYes ? (tick.prices?.up ?? pos.current_price) : (tick.prices?.down ?? pos.current_price);
      closePosition(pos.id, finalPrice, "settled");
    }
  }
}

/**
 * Get all open positions with unrealized P&L.
 */
export function getOpenPositions() {
  if (!stmts) ensureTable();

  const positions = stmts.getOpen.all();
  return positions.map(pos => {
    const unrealizedPnl = pos.entry_price > 0
      ? ((pos.current_price - pos.entry_price) / pos.entry_price) * pos.bet_pct * 100
      : 0;

    return {
      ...pos,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100
    };
  });
}

/**
 * Get portfolio summary.
 */
export function getPortfolioSummary() {
  if (!stmts) ensureTable();

  const summary = stmts.getSummary.get();
  const byCategory = stmts.getCategorySummary.all();
  const openPositions = getOpenPositions();

  const totalUnrealized = openPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const winRate = summary.wins + summary.losses > 0
    ? (summary.wins / (summary.wins + summary.losses) * 100).toFixed(1)
    : null;

  return {
    ...summary,
    winRate,
    totalUnrealized: Math.round(totalUnrealized * 100) / 100,
    totalPnl: Math.round(((summary.realized_pnl || 0) + totalUnrealized) * 100) / 100,
    byCategory
  };
}

/**
 * Get recent positions (open + closed).
 */
export function getRecentPositions(limit = 20) {
  if (!stmts) ensureTable();
  return stmts.getRecent.all({ limit });
}

/**
 * Initialize portfolio tables.
 */
export function initPortfolio() {
  ensureTable();
}
