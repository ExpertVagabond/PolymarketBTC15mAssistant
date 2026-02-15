/**
 * Risk management: max bet, daily loss limit, position tracking, circuit breaker.
 * State persisted to SQLite so it survives process restarts.
 * Env: MAX_BET_USD=1, DAILY_LOSS_LIMIT_USD=10, MAX_OPEN_POSITIONS=3
 */

import { getDb } from "../subscribers/db.js";

const MAX_BET = Number(process.env.MAX_BET_USD) || 1;
const DAILY_LOSS_LIMIT = Number(process.env.DAILY_LOSS_LIMIT_USD) || 10;
const MAX_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS) || 3;
const MAX_CATEGORY_CONCENTRATION = Number(process.env.MAX_CATEGORY_CONCENTRATION_PCT) || 50; // max % in one category
const MAX_TOTAL_EXPOSURE = Number(process.env.MAX_TOTAL_EXPOSURE_USD) || 50;

let initialized = false;
let dailyPnl = 0;
let dailyResetDate = "";
let openPositions = 0;
let circuitBroken = false;
let totalTrades = 0;
let totalPnl = 0;

function ensureTable() {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      daily_pnl REAL DEFAULT 0,
      daily_reset_date TEXT DEFAULT '',
      open_positions INTEGER DEFAULT 0,
      circuit_broken INTEGER DEFAULT 0,
      total_trades INTEGER DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Ensure the single row exists
  db.prepare("INSERT OR IGNORE INTO risk_state (id) VALUES (1)").run();
  initialized = true;
}

function loadState() {
  ensureTable();
  const row = getDb().prepare("SELECT * FROM risk_state WHERE id = 1").get();
  if (row) {
    dailyPnl = row.daily_pnl;
    dailyResetDate = row.daily_reset_date;
    openPositions = row.open_positions;
    circuitBroken = !!row.circuit_broken;
    totalTrades = row.total_trades;
    totalPnl = row.total_pnl;
  }
}

function saveState() {
  ensureTable();
  getDb().prepare(`
    UPDATE risk_state SET
      daily_pnl = ?, daily_reset_date = ?, open_positions = ?,
      circuit_broken = ?, total_trades = ?, total_pnl = ?,
      updated_at = datetime('now')
    WHERE id = 1
  `).run(dailyPnl, dailyResetDate, openPositions, circuitBroken ? 1 : 0, totalTrades, totalPnl);
}

// Load on first access
let loaded = false;
function ensureLoaded() {
  if (!loaded) { loadState(); loaded = true; }
}

function checkDayReset() {
  ensureLoaded();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  if (today !== dailyResetDate) {
    dailyPnl = 0;
    dailyResetDate = today;
    circuitBroken = false;
    saveState();
  }
}

export function canTrade(category = null) {
  checkDayReset();
  if (circuitBroken) return { allowed: false, reason: "circuit_breaker" };
  if (dailyPnl <= -DAILY_LOSS_LIMIT) return { allowed: false, reason: "daily_loss_limit" };
  if (openPositions >= MAX_POSITIONS) return { allowed: false, reason: "max_positions" };

  // Check total exposure
  const exposure = getExposure();
  if (exposure.totalExposure >= MAX_TOTAL_EXPOSURE) {
    return { allowed: false, reason: `total_exposure_limit ($${exposure.totalExposure.toFixed(2)}/$${MAX_TOTAL_EXPOSURE})` };
  }

  // Check category concentration
  if (category && exposure.totalExposure > 0) {
    const catExposure = exposure.byCategory[category] || 0;
    const catPct = (catExposure / exposure.totalExposure) * 100;
    if (catPct >= MAX_CATEGORY_CONCENTRATION && catExposure > 0) {
      return { allowed: false, reason: `category_concentration (${category}: ${catPct.toFixed(0)}%)` };
    }
  }

  return { allowed: true };
}

export function getBetSize(edge) {
  // Simple edge-proportional sizing, capped at MAX_BET
  return Math.min(MAX_BET, Math.max(0.1, Math.abs(edge) * 10));
}

export function recordTradeOpen() {
  ensureLoaded();
  openPositions++;
  totalTrades++;
  saveState();
}

export function recordTradeClose(pnl) {
  ensureLoaded();
  openPositions = Math.max(0, openPositions - 1);
  dailyPnl += pnl;
  totalPnl += pnl;
  if (dailyPnl <= -DAILY_LOSS_LIMIT) {
    circuitBroken = true;
  }
  saveState();
}

export function tripCircuitBreaker(reason) {
  ensureLoaded();
  circuitBroken = true;
  saveState();
  console.log(`[risk] Circuit breaker tripped: ${reason}`);
}

/**
 * Calculate current exposure from open trade_executions.
 */
export function getExposure() {
  ensureTable();
  try {
    const rows = getDb().prepare(
      "SELECT category, amount FROM trade_executions WHERE status = 'open'"
    ).all();
    const byCategory = {};
    let totalExposure = 0;
    for (const row of rows) {
      totalExposure += row.amount;
      const cat = row.category || "other";
      byCategory[cat] = (byCategory[cat] || 0) + row.amount;
    }
    // Build concentration warnings
    const warnings = [];
    for (const [cat, amt] of Object.entries(byCategory)) {
      const pct = totalExposure > 0 ? (amt / totalExposure) * 100 : 0;
      if (pct >= MAX_CATEGORY_CONCENTRATION) {
        warnings.push({ category: cat, exposureUsd: amt, concentrationPct: Math.round(pct) });
      }
    }
    return { totalExposure, maxExposure: MAX_TOTAL_EXPOSURE, byCategory, warnings };
  } catch {
    return { totalExposure: 0, maxExposure: MAX_TOTAL_EXPOSURE, byCategory: {}, warnings: [] };
  }
}

export function getRiskStatus() {
  checkDayReset();
  const exposure = getExposure();
  return {
    dailyPnl,
    dailyLossLimit: DAILY_LOSS_LIMIT,
    openPositions,
    maxPositions: MAX_POSITIONS,
    maxBet: MAX_BET,
    circuitBroken,
    totalTrades,
    totalPnl,
    dailyResetDate,
    exposure
  };
}

/**
 * Force-sync open position count from the trade_executions table.
 * Useful after restart to reconcile with actual open trades.
 */
export function syncOpenPositions(count) {
  ensureLoaded();
  openPositions = count;
  saveState();
}
