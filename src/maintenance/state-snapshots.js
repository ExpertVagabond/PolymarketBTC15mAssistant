/**
 * State snapshot & recovery system.
 *
 * Periodically captures system state for graceful restart after crashes:
 * - Open trade executions and their status
 * - Risk manager state (daily P&L, positions, circuit breaker)
 * - Bot control state (running/paused/stopped)
 * - Learning weights version
 * - Ensemble model weights
 *
 * Snapshots stored in SQLite, pruned after 7 days.
 * On startup, loadLatestSnapshot() restores the last known state.
 */

import { getDb } from "../subscribers/db.js";
import { getRiskStatus } from "../trading/risk-manager.js";
import { getBotControlState } from "../trading/bot-control.js";
import { getOpenExecutions, getExecutionStats } from "../trading/execution-log.js";
import { getLearningStatus } from "../engines/weights.js";

let snapshotCount = 0;
let lastSnapshotAt = null;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      snapshot_type TEXT DEFAULT 'periodic',
      open_positions INTEGER,
      risk_state TEXT,
      bot_state TEXT,
      learning_version TEXT,
      execution_stats TEXT,
      metadata TEXT
    )
  `);
}

/**
 * Take a snapshot of current system state.
 * @param {string} type - "periodic", "startup", "shutdown", "manual"
 * @returns {{ id, timestamp, summary }}
 */
export function takeSnapshot(type = "periodic") {
  ensureTable();
  const db = getDb();

  let openPositions = 0;
  let riskState = {};
  let botState = {};
  let learningVersion = "";
  let execStats = {};

  try { const open = getOpenExecutions(); openPositions = Array.isArray(open) ? open.length : 0; } catch { /* ok */ }
  try { riskState = getRiskStatus(); } catch { /* ok */ }
  try { botState = getBotControlState(); } catch { /* ok */ }
  try { const ls = getLearningStatus(); learningVersion = ls.modelVersion || ""; } catch { /* ok */ }
  try { execStats = getExecutionStats(); } catch { /* ok */ }

  const result = db.prepare(`
    INSERT INTO state_snapshots (snapshot_type, open_positions, risk_state, bot_state, learning_version, execution_stats, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    type,
    openPositions,
    JSON.stringify(riskState),
    JSON.stringify(botState),
    learningVersion,
    JSON.stringify(execStats),
    JSON.stringify({ pid: process.pid, uptime: process.uptime(), memMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) })
  );

  snapshotCount++;
  lastSnapshotAt = new Date().toISOString();

  return {
    id: result.lastInsertRowid,
    timestamp: lastSnapshotAt,
    summary: { type, openPositions, botState: botState.state || "unknown", learningVersion }
  };
}

/**
 * Load the latest snapshot for recovery.
 * @returns {object|null} Parsed snapshot or null if none exists
 */
export function loadLatestSnapshot() {
  ensureTable();
  const db = getDb();
  const row = db.prepare("SELECT * FROM state_snapshots ORDER BY id DESC LIMIT 1").get();
  if (!row) return null;

  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.snapshot_type,
    openPositions: row.open_positions,
    riskState: row.risk_state ? JSON.parse(row.risk_state) : null,
    botState: row.bot_state ? JSON.parse(row.bot_state) : null,
    learningVersion: row.learning_version,
    executionStats: row.execution_stats ? JSON.parse(row.execution_stats) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null
  };
}

/**
 * Get snapshot history.
 * @param {number} limit
 */
export function getSnapshotHistory(limit = 50) {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, timestamp, snapshot_type, open_positions, bot_state, learning_version FROM state_snapshots ORDER BY id DESC LIMIT ?"
  ).all(Math.min(limit, 500));

  return {
    snapshots: rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      type: r.snapshot_type,
      openPositions: r.open_positions,
      botState: r.bot_state ? JSON.parse(r.bot_state).state : "unknown",
      learningVersion: r.learning_version
    })),
    totalSnapshots: snapshotCount,
    lastSnapshotAt
  };
}

/**
 * Prune old snapshots.
 * @param {number} days - keep snapshots newer than this
 */
export function pruneSnapshots(days = 7) {
  ensureTable();
  const db = getDb();
  const result = db.prepare("DELETE FROM state_snapshots WHERE timestamp < datetime('now', ?)").run(`-${days} days`);
  return result.changes;
}

/**
 * Start periodic snapshot schedule.
 * Takes a snapshot every 2 minutes.
 */
export function startSnapshotSchedule() {
  // Initial snapshot on startup
  setTimeout(() => {
    try { takeSnapshot("startup"); } catch (err) { console.error("[snapshots]", err.message); }
  }, 10_000);

  // Every 2 minutes
  setInterval(() => {
    try { takeSnapshot("periodic"); } catch (err) { console.error("[snapshots]", err.message); }
  }, 2 * 60 * 1000);

  // Prune weekly
  setInterval(() => {
    try { pruneSnapshots(7); } catch { /* ok */ }
  }, 24 * 60 * 60 * 1000);
}
