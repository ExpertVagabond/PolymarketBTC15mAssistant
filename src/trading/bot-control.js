/**
 * Runtime trading bot control: stop/pause/resume/drain without process restart.
 * State persisted to SQLite so it survives restarts.
 *
 * States:
 *  - "running" — bot places new trades, monitor runs
 *  - "paused"  — no new trades, monitor keeps running (TP/SL/settlement)
 *  - "stopped" — no new trades, monitor paused
 *  - "draining" — no new trades, monitor runs, auto-stops when all positions closed
 */

import { getDb } from "../subscribers/db.js";
import { logAuditEvent } from "./audit-log.js";

let initialized = false;
let _state = "running";
let _stateChangedAt = null;
let _stateReason = null;

function ensureTable() {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT DEFAULT 'running',
      changed_at TEXT DEFAULT (datetime('now')),
      reason TEXT
    )
  `);
  db.prepare("INSERT OR IGNORE INTO bot_control (id) VALUES (1)").run();
  initialized = true;
}

function load() {
  ensureTable();
  const row = getDb().prepare("SELECT * FROM bot_control WHERE id = 1").get();
  if (row) {
    _state = row.state;
    _stateChangedAt = row.changed_at;
    _stateReason = row.reason;
  }
}

function save() {
  ensureTable();
  getDb().prepare("UPDATE bot_control SET state = ?, changed_at = datetime('now'), reason = ? WHERE id = 1").run(_state, _stateReason);
  _stateChangedAt = new Date().toISOString();
}

let loaded = false;
function ensureLoaded() {
  if (!loaded) { load(); loaded = true; }
}

/**
 * Check if new trades are allowed.
 */
export function canOpenNewTrades() {
  ensureLoaded();
  return _state === "running";
}

/**
 * Check if settlement monitor should run.
 */
export function isMonitorActive() {
  ensureLoaded();
  return _state !== "stopped";
}

/**
 * Set bot state.
 */
export function setBotState(state, reason) {
  ensureLoaded();
  const valid = ["running", "paused", "stopped", "draining"];
  if (!valid.includes(state)) return { error: `Invalid state. Use: ${valid.join(", ")}` };

  const prev = _state;
  _state = state;
  _stateReason = reason || null;
  save();

  logAuditEvent("BOT_STATE_CHANGE", { detail: { from: prev, to: state, reason } });
  console.log(`[bot-control] ${prev} -> ${state}${reason ? ` (${reason})` : ""}`);
  return { ok: true, previous: prev, current: state, reason };
}

/**
 * Get current bot control state.
 */
export function getBotControlState() {
  ensureLoaded();
  return {
    state: _state,
    changedAt: _stateChangedAt,
    reason: _stateReason,
    canTrade: _state === "running",
    monitorActive: _state !== "stopped"
  };
}

/**
 * Called by settlement monitor when a position closes during drain mode.
 * If no positions remain, auto-transition to paused.
 */
export function checkDrainComplete(openPositionCount) {
  ensureLoaded();
  if (_state === "draining" && openPositionCount === 0) {
    setBotState("paused", "drain_complete");
    console.log("[bot-control] Drain complete — all positions closed, now paused");
  }
}
