/**
 * Database maintenance scheduler.
 * Runs periodic cleanup tasks:
 * - Void stale signals (>24h unsettled)
 * - Purge old settled signals (>90 days)
 * - Purge old webhook queue entries (>7 days)
 * - SQLite ANALYZE for query optimizer
 */

import { voidStaleSignals, purgeOldSignals } from "../signals/history.js";
import { purgeQueue } from "../notifications/webhook-queue.js";
import { getDb } from "../subscribers/db.js";

let lastRun = null;
let runCount = 0;
let lastResults = null;

/**
 * Run all maintenance tasks.
 */
export function runMaintenance() {
  const start = Date.now();
  const results = {};

  try {
    results.voided = voidStaleSignals();
  } catch (err) {
    results.voided = { error: err.message };
  }

  try {
    results.purgedSignals = purgeOldSignals(90);
  } catch (err) {
    results.purgedSignals = { error: err.message };
  }

  try {
    const qr = purgeQueue(7);
    results.purgedQueue = qr?.changes ?? 0;
  } catch (err) {
    results.purgedQueue = { error: err.message };
  }

  try {
    const db = getDb();
    db.exec("ANALYZE");
    results.analyze = "ok";
  } catch (err) {
    results.analyze = { error: err.message };
  }

  results.durationMs = Date.now() - start;
  lastRun = new Date().toISOString();
  lastResults = results;
  runCount++;

  const total = (results.voided || 0) + (results.purgedSignals || 0) + (results.purgedQueue || 0);
  if (total > 0 || runCount % 10 === 1) {
    console.log(`[maintenance] Run #${runCount}: voided=${results.voided}, purgedSignals=${results.purgedSignals}, purgedQueue=${results.purgedQueue}, analyze=${results.analyze}, ${results.durationMs}ms`);
  }

  return results;
}

/**
 * Get maintenance status.
 */
export function getMaintenanceStatus() {
  return {
    lastRun,
    runCount,
    lastResults,
    intervalHours: 1
  };
}

/**
 * Start the maintenance schedule (runs every hour).
 */
export function startMaintenanceSchedule() {
  // Run once on startup (15s delay for DB init)
  setTimeout(() => {
    try { runMaintenance(); } catch (err) { console.error("[maintenance]", err.message); }
  }, 15_000);

  // Then every hour
  const interval = setInterval(() => {
    try { runMaintenance(); } catch (err) { console.error("[maintenance]", err.message); }
  }, 60 * 60 * 1000);

  return interval;
}
