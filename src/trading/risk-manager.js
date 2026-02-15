/**
 * Risk management: max bet, daily loss limit, position tracking, circuit breaker.
 * State persisted to SQLite so it survives process restarts.
 * Env: MAX_BET_USD=1, DAILY_LOSS_LIMIT_USD=10, MAX_OPEN_POSITIONS=3
 */

import { getDb } from "../subscribers/db.js";
import { getConfigValue } from "./trading-config.js";
import { computeSignalKelly } from "../engines/kelly.js";

// Dynamic getters — read from trading-config (SQLite-backed, changeable at runtime)
function MAX_BET() { return getConfigValue("max_bet_usd"); }
function DAILY_LOSS_LIMIT() { return getConfigValue("daily_loss_limit_usd"); }
function MAX_POSITIONS() { return getConfigValue("max_open_positions"); }
function MAX_CATEGORY_CONCENTRATION() { return getConfigValue("max_category_concentration_pct"); }
function MAX_TOTAL_EXPOSURE() { return getConfigValue("max_total_exposure_usd"); }

let initialized = false;
let dailyPnl = 0;
let dailyResetDate = "";
let openPositions = 0;
let circuitBroken = false;
let totalTrades = 0;
let totalPnl = 0;

// Multi-tier breaker state
let breakerTier = "none"; // none | warning | caution | tripped
let recoveryMode = false;
let recoveryWins = 0;

// Velocity tracking: rolling 30-minute P&L window
const velocityWindow = []; // { timestamp, pnl }
const VELOCITY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const VELOCITY_LOSS_THRESHOLD_PCT = 0.5; // 50% of daily loss limit in 30 min = velocity trip

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
    // Enter recovery mode if breaker was tripped yesterday
    if (circuitBroken || breakerTier === "tripped") {
      recoveryMode = true;
      recoveryWins = 0;
      console.log("[risk] Entering recovery mode (breaker was tripped yesterday — 50% sizing until 2 wins)");
    }
    dailyPnl = 0;
    dailyResetDate = today;
    circuitBroken = false;
    breakerTier = "none";
    velocityWindow.length = 0;
    saveState();
  }
}

export function canTrade(category = null) {
  checkDayReset();
  if (circuitBroken) return { allowed: false, reason: "circuit_breaker" };
  if (dailyPnl <= -DAILY_LOSS_LIMIT()) return { allowed: false, reason: "daily_loss_limit" };

  // Caution tier: halve max positions
  const effectiveMaxPositions = breakerTier === "caution" ? Math.max(1, Math.floor(MAX_POSITIONS() / 2)) : MAX_POSITIONS();
  if (openPositions >= effectiveMaxPositions) return { allowed: false, reason: `max_positions${breakerTier === "caution" ? "_caution" : ""}` };

  // Check total exposure
  const exposure = getExposure();
  if (exposure.totalExposure >= MAX_TOTAL_EXPOSURE()) {
    return { allowed: false, reason: `total_exposure_limit ($${exposure.totalExposure.toFixed(2)}/$${MAX_TOTAL_EXPOSURE()})` };
  }

  // Check category concentration
  if (category && exposure.totalExposure > 0) {
    const catExposure = exposure.byCategory[category] || 0;
    const catPct = (catExposure / exposure.totalExposure) * 100;
    if (catPct >= MAX_CATEGORY_CONCENTRATION() && catExposure > 0) {
      return { allowed: false, reason: `category_concentration (${category}: ${catPct.toFixed(0)}%)` };
    }
  }

  return { allowed: true };
}

export function getBetSize(edge) {
  // Simple edge-proportional sizing, capped at MAX_BET (fallback when no tick available)
  return Math.min(MAX_BET(), Math.max(0.1, Math.abs(edge) * 10));
}

/**
 * Get recent trade streak info (consecutive wins or losses).
 * Queries the last N closed executions to detect hot/cold streaks.
 * @returns {{ streak: number, direction: 'win'|'loss'|'none', multiplier: number }}
 */
export function getStreakMultiplier() {
  try {
    const rows = getDb().prepare(
      "SELECT pnl_usd FROM trade_executions WHERE status = 'closed' AND pnl_usd IS NOT NULL ORDER BY closed_at DESC LIMIT 10"
    ).all();

    if (rows.length < 2) return { streak: 0, direction: "none", multiplier: 1.0 };

    let streak = 0;
    const firstDir = rows[0].pnl_usd >= 0 ? "win" : "loss";
    for (const row of rows) {
      const dir = row.pnl_usd >= 0 ? "win" : "loss";
      if (dir === firstDir) streak++;
      else break;
    }

    let multiplier = 1.0;
    if (firstDir === "loss") {
      if (streak >= 5) multiplier = 0.25;
      else if (streak >= 3) multiplier = 0.5;
    } else if (firstDir === "win" && streak >= 3) {
      multiplier = Math.min(1.2, 1.0 + streak * 0.033); // cap at 1.2x
    }

    return { streak, direction: firstDir, multiplier };
  } catch {
    return { streak: 0, direction: "none", multiplier: 1.0 };
  }
}

/**
 * Kelly-aware bet sizing. Uses computeSignalKelly when a full tick is available.
 * Falls back to naive edge-proportional sizing if Kelly returns 0 or data is missing.
 * Applies streak-adaptive multiplier: cold streak → reduce, hot streak → modest boost.
 * @param {object} tick - Full tick from poller/scanner (needs rec, prices, timeAware)
 * @param {number} bankroll - Current bankroll in USD (for converting betPct to dollars)
 * @returns {{ amount: number, method: string, kelly: object|null, sizingTier: string|null, streakMult: number }}
 */
export function getKellyBetSize(tick, bankroll = 100) {
  const edge = tick.rec?.side === "UP" ? tick.edge?.edgeUp : tick.edge?.edgeDown;
  const naiveFallback = getBetSize(edge ?? 0.1);

  const streakInfo = getStreakMultiplier();
  const sm = streakInfo.multiplier;

  try {
    const { kelly, sizingTier } = computeSignalKelly(tick);
    if (kelly.reason === "ok" && kelly.betPct > 0) {
      const kellyAmount = Math.min(MAX_BET(), Math.max(0.1, kelly.betPct * bankroll * sm));
      return { amount: kellyAmount, method: "kelly", kelly, sizingTier, streakMult: sm };
    }
    return { amount: Math.max(0.1, naiveFallback * sm), method: "naive", kelly, sizingTier, streakMult: sm };
  } catch {
    return { amount: Math.max(0.1, naiveFallback * sm), method: "naive", kelly: null, sizingTier: null, streakMult: sm };
  }
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

  // Velocity tracking
  if (pnl < 0) {
    velocityWindow.push({ timestamp: Date.now(), pnl });
    // Prune old entries
    const cutoff = Date.now() - VELOCITY_WINDOW_MS;
    while (velocityWindow.length > 0 && velocityWindow[0].timestamp < cutoff) velocityWindow.shift();
  }

  // Multi-tier breaker evaluation
  const limit = DAILY_LOSS_LIMIT();
  const lossPct = limit > 0 ? Math.abs(dailyPnl) / limit : 0;

  if (dailyPnl <= -limit) {
    circuitBroken = true;
    breakerTier = "tripped";
    console.log(`[risk] CIRCUIT BREAKER: daily loss limit hit ($${dailyPnl.toFixed(2)} / -$${limit})`);
  } else if (lossPct >= 0.75) {
    breakerTier = "caution";
    console.log(`[risk] CAUTION: 75% of daily loss limit ($${dailyPnl.toFixed(2)} / -$${limit})`);
  } else if (lossPct >= 0.50) {
    breakerTier = "warning";
  } else {
    breakerTier = dailyPnl < 0 ? "warning" : "none";
    if (lossPct < 0.50) breakerTier = "none";
  }

  // Velocity check: sum losses in rolling window
  const velocityLoss = velocityWindow.reduce((sum, v) => sum + v.pnl, 0);
  const velocityThreshold = limit * VELOCITY_LOSS_THRESHOLD_PCT;
  if (velocityLoss <= -velocityThreshold && !circuitBroken) {
    circuitBroken = true;
    breakerTier = "tripped";
    console.log(`[risk] VELOCITY BREAKER: $${velocityLoss.toFixed(2)} lost in ${VELOCITY_WINDOW_MS / 60000}min (threshold: -$${velocityThreshold.toFixed(2)})`);
  }

  // Recovery mode tracking
  if (recoveryMode) {
    if (pnl > 0) {
      recoveryWins++;
      if (recoveryWins >= 2) {
        recoveryMode = false;
        recoveryWins = 0;
        console.log("[risk] Recovery mode exited (2 consecutive wins)");
      }
    } else if (pnl < 0) {
      recoveryWins = 0; // reset on any loss
    }
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
    const concLimit = MAX_CATEGORY_CONCENTRATION();
    for (const [cat, amt] of Object.entries(byCategory)) {
      const pct = totalExposure > 0 ? (amt / totalExposure) * 100 : 0;
      if (pct >= concLimit) {
        warnings.push({ category: cat, exposureUsd: amt, concentrationPct: Math.round(pct) });
      }
    }
    return { totalExposure, maxExposure: MAX_TOTAL_EXPOSURE(), byCategory, warnings };
  } catch {
    return { totalExposure: 0, maxExposure: MAX_TOTAL_EXPOSURE(), byCategory: {}, warnings: [] };
  }
}

/**
 * Get recovery mode sizing multiplier. Returns 0.5 during recovery, 1.0 otherwise.
 */
export function getRecoveryMultiplier() {
  return recoveryMode ? 0.5 : 1.0;
}

export function getRiskStatus() {
  checkDayReset();
  const exposure = getExposure();
  const limit = DAILY_LOSS_LIMIT();
  return {
    dailyPnl,
    dailyLossLimit: limit,
    openPositions,
    maxPositions: MAX_POSITIONS(),
    maxBet: MAX_BET(),
    circuitBroken,
    breakerTier,
    recoveryMode,
    recoveryWins,
    velocityLoss: velocityWindow.reduce((s, v) => s + v.pnl, 0),
    velocityThreshold: limit * VELOCITY_LOSS_THRESHOLD_PCT,
    totalTrades,
    totalPnl,
    dailyResetDate,
    exposure,
    streak: getStreakMultiplier()
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
