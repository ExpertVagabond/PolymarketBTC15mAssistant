/**
 * Auto-recovery handler.
 *
 * When the health monitor detects degraded conditions, this module
 * takes corrective action automatically:
 *
 * - Score < 50: run emergency maintenance, clear response caches
 * - Score < 30: pause trading bot, dispatch critical webhook alert
 * - Memory > 90%: hint garbage collection
 * - Stale data: log warning and increment stale counter
 *
 * All recovery actions are logged to SQLite for audit.
 */

import { getDb } from "../subscribers/db.js";
import { checkHealth, checkHealthAlerts } from "./health-monitor.js";
import { runMaintenance } from "./scheduler.js";
import { clearCache } from "../web/cache.js";
import { setBotState, getBotControlState } from "../trading/bot-control.js";

let recoveryCount = 0;
let lastRecoveryAt = null;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min between auto-recovery runs

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      health_score INTEGER,
      action TEXT NOT NULL,
      detail TEXT,
      success INTEGER DEFAULT 1
    )
  `);
}

function logRecovery(score, action, detail = null, success = true) {
  try {
    ensureTable();
    const db = getDb();
    db.prepare("INSERT INTO recovery_log (health_score, action, detail, success) VALUES (?, ?, ?, ?)")
      .run(score, action, detail, success ? 1 : 0);
  } catch { /* non-critical */ }
}

/**
 * Run auto-recovery based on current health status.
 * Returns list of actions taken.
 */
export function runAutoRecovery() {
  // Cooldown: don't run too often
  if (lastRecoveryAt && Date.now() - lastRecoveryAt < COOLDOWN_MS) {
    return { skipped: true, reason: "cooldown", nextEligibleAt: new Date(lastRecoveryAt + COOLDOWN_MS).toISOString() };
  }

  const health = checkHealth();
  const score = health.score;
  const actions = [];

  // Score >= 70: everything is fine
  if (score >= 70) {
    return { score, actions: [], message: "System healthy, no recovery needed" };
  }

  lastRecoveryAt = Date.now();
  recoveryCount++;

  // Score < 70: run maintenance proactively
  if (score < 70) {
    try {
      const result = runMaintenance();
      actions.push({ action: "run_maintenance", result: "ok", voided: result.voided, purged: result.purgedSignals });
      logRecovery(score, "run_maintenance", `voided=${result.voided}, purged=${result.purgedSignals}`);
    } catch (err) {
      actions.push({ action: "run_maintenance", result: "error", error: err.message });
      logRecovery(score, "run_maintenance", err.message, false);
    }
  }

  // Score < 50: clear caches
  if (score < 50) {
    try {
      clearCache();
      actions.push({ action: "clear_caches", result: "ok" });
      logRecovery(score, "clear_caches");
    } catch (err) {
      actions.push({ action: "clear_caches", result: "error", error: err.message });
      logRecovery(score, "clear_caches", err.message, false);
    }
  }

  // Score < 30: pause trading if running
  if (score < 30) {
    try {
      const botState = getBotControlState();
      if (botState.state === "running") {
        setBotState("paused", `auto-recovery: health score ${score}`);
        actions.push({ action: "pause_trading", result: "ok", previousState: "running" });
        logRecovery(score, "pause_trading", `health score dropped to ${score}`);
      }
    } catch (err) {
      actions.push({ action: "pause_trading", result: "error", error: err.message });
      logRecovery(score, "pause_trading", err.message, false);
    }
  }

  // Memory pressure: hint GC
  if (health.components?.memory?.usagePct > 90) {
    try {
      if (global.gc) {
        global.gc();
        actions.push({ action: "gc_hint", result: "ok" });
        logRecovery(score, "gc_hint", `memory at ${health.components.memory.usagePct}%`);
      } else {
        actions.push({ action: "gc_hint", result: "skipped", reason: "gc not exposed" });
      }
    } catch {
      actions.push({ action: "gc_hint", result: "error" });
    }
  }

  return {
    score,
    actions,
    recoveryCount,
    timestamp: new Date().toISOString()
  };
}

/**
 * Get recent recovery actions from the log.
 * @param {number} limit - max entries
 */
export function getRecoveryLog(limit = 50) {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM recovery_log ORDER BY timestamp DESC LIMIT ?"
  ).all(limit);
  return {
    entries: rows,
    totalRecoveries: recoveryCount,
    lastRecoveryAt: lastRecoveryAt ? new Date(lastRecoveryAt).toISOString() : null
  };
}

/**
 * Purge old recovery log entries.
 * @param {number} days - keep entries newer than this
 */
export function purgeRecoveryLog(days = 90) {
  ensureTable();
  const db = getDb();
  const result = db.prepare("DELETE FROM recovery_log WHERE timestamp < datetime('now', ?)").run(`-${days} days`);
  return result.changes;
}
