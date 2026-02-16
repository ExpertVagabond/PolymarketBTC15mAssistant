/**
 * System health monitor.
 *
 * Tracks operational metrics and computes a composite health score (0-100):
 * - Memory usage (heap vs available)
 * - Error rate (recent errors from structured logger)
 * - Execution success rate (from trade executions)
 * - Data freshness (from data-freshness module)
 * - DB WAL size (SQLite WAL file growth)
 *
 * Persists health snapshots every check for trend analysis.
 */

import { getDb } from "../subscribers/db.js";
import { getErrorTrends } from "../logging/structured-logger.js";
import { checkStaleness } from "../net/data-freshness.js";
import { getExecutionStats } from "../trading/execution-log.js";

let healthHistory = [];  // in-memory ring buffer, last 288 entries (24h at 5min intervals)
const MAX_HISTORY = 288;
let lastCheck = null;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      score INTEGER NOT NULL,
      memory_pct REAL,
      error_rate REAL,
      exec_success_rate REAL,
      freshness_score REAL,
      wal_size_mb REAL,
      details TEXT
    )
  `);
}

/**
 * Run a health check and return the current health score.
 * @returns {{ score: number, components: object, alerts: string[], timestamp: string }}
 */
export function checkHealth() {
  ensureTable();
  const components = {};
  const alerts = [];
  let totalScore = 0;
  let totalWeight = 0;

  // 1. Memory usage (weight: 20)
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const memPct = heapTotalMB > 0 ? (heapUsedMB / heapTotalMB) * 100 : 0;
  const memScore = memPct < 60 ? 100 : memPct < 80 ? 70 : memPct < 95 ? 30 : 0;
  components.memory = { score: memScore, heapUsedMB, heapTotalMB, rssMB, usagePct: Math.round(memPct) };
  if (memScore < 50) alerts.push(`High memory usage: ${Math.round(memPct)}% heap`);
  totalScore += memScore * 20;
  totalWeight += 20;

  // 2. Error rate (weight: 25)
  let errorScore = 100;
  try {
    const trends = getErrorTrends(1);
    const recentErrors = (trends.byLevel || []).reduce((sum, l) => sum + (l.level === "error" ? l.count : 0), 0);
    const totalLogs = (trends.byLevel || []).reduce((sum, l) => sum + l.count, 0);
    const errorRate = totalLogs > 0 ? recentErrors / totalLogs : 0;
    errorScore = errorRate < 0.01 ? 100 : errorRate < 0.05 ? 80 : errorRate < 0.15 ? 50 : errorRate < 0.3 ? 20 : 0;
    components.errors = { score: errorScore, recentErrors, totalLogs, errorRate: Math.round(errorRate * 100) / 100 };
    if (errorScore < 50) alerts.push(`High error rate: ${(errorRate * 100).toFixed(1)}%`);
  } catch {
    components.errors = { score: 100, recentErrors: 0, note: "logger unavailable" };
  }
  totalScore += errorScore * 25;
  totalWeight += 25;

  // 3. Execution success rate (weight: 25)
  let execScore = 100;
  try {
    const stats = getExecutionStats();
    const total = (stats.total || 0);
    const wins = (stats.wins || 0);
    const losses = (stats.losses || 0);
    const settled = wins + losses;
    const winRate = settled > 0 ? wins / settled : 0.5;
    // Score based on having executions and reasonable win rate
    if (total === 0) {
      execScore = 80; // No trades is fine, just not great
    } else {
      execScore = winRate >= 0.5 ? 100 : winRate >= 0.4 ? 70 : winRate >= 0.3 ? 40 : 20;
    }
    components.executions = { score: execScore, total, wins, losses, winRate: Math.round(winRate * 100) };
    if (execScore < 40) alerts.push(`Low execution win rate: ${(winRate * 100).toFixed(1)}%`);
  } catch {
    components.executions = { score: 80, note: "execution stats unavailable" };
  }
  totalScore += execScore * 25;
  totalWeight += 25;

  // 4. Data freshness (weight: 20)
  let freshnessScore = 100;
  try {
    const staleness = checkStaleness();
    if (staleness.isStale) {
      const staleCount = (staleness.staleSources || []).length;
      freshnessScore = staleCount <= 1 ? 60 : staleCount <= 3 ? 30 : 0;
      if (freshnessScore < 50) alerts.push(`${staleCount} stale data source(s)`);
    }
    components.freshness = { score: freshnessScore, isStale: staleness.isStale, staleSources: staleness.staleSources || [] };
  } catch {
    components.freshness = { score: 80, note: "freshness check unavailable" };
    freshnessScore = 80;
  }
  totalScore += freshnessScore * 20;
  totalWeight += 20;

  // 5. DB WAL size (weight: 10)
  let walScore = 100;
  try {
    const db = getDb();
    const walInfo = db.pragma("wal_checkpoint(PASSIVE)");
    const pageSize = db.pragma("page_size")[0]?.page_size || 4096;
    const walPages = walInfo[0]?.log || 0;
    const walSizeMB = (walPages * pageSize) / (1024 * 1024);
    walScore = walSizeMB < 10 ? 100 : walSizeMB < 50 ? 70 : walSizeMB < 200 ? 30 : 0;
    components.database = { score: walScore, walSizeMB: Math.round(walSizeMB * 10) / 10, walPages };
    if (walScore < 50) alerts.push(`Large WAL: ${walSizeMB.toFixed(1)}MB`);
  } catch {
    components.database = { score: 80, note: "WAL check unavailable" };
    walScore = 80;
  }
  totalScore += walScore * 10;
  totalWeight += 10;

  // Composite score
  const score = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
  const timestamp = new Date().toISOString();

  const snapshot = { score, components, alerts, timestamp };
  lastCheck = snapshot;

  // Persist to ring buffer
  healthHistory.push({ score, timestamp, alerts: alerts.length });
  if (healthHistory.length > MAX_HISTORY) healthHistory.shift();

  // Persist to DB
  try {
    const db = getDb();
    db.prepare(`INSERT INTO health_snapshots (score, memory_pct, error_rate, exec_success_rate, freshness_score, wal_size_mb, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      score,
      components.memory?.usagePct || 0,
      components.errors?.errorRate || 0,
      components.executions?.winRate || 0,
      components.freshness?.score || 0,
      components.database?.walSizeMB || 0,
      JSON.stringify({ alerts, components })
    );
  } catch { /* non-critical */ }

  return snapshot;
}

/**
 * Get the most recent health check result.
 */
export function getHealthScore() {
  if (!lastCheck) return checkHealth();
  return lastCheck;
}

/**
 * Get health history (in-memory ring buffer).
 * @param {number} limit - max entries to return
 */
export function getHealthHistory(limit = 50) {
  return healthHistory.slice(-limit);
}

/**
 * Get persisted health snapshots from DB.
 * @param {number} hours - lookback window
 */
export function getHealthTrend(hours = 24) {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    `SELECT score, timestamp, memory_pct, error_rate, exec_success_rate, freshness_score, wal_size_mb
     FROM health_snapshots
     WHERE timestamp > datetime('now', ?)
     ORDER BY timestamp ASC`
  ).all(`-${hours} hours`);
  return { snapshots: rows, count: rows.length, hours };
}

/**
 * Check if any health alerts are active.
 * @returns {{ healthy: boolean, score: number, alerts: string[] }}
 */
export function checkHealthAlerts() {
  const health = getHealthScore();
  return {
    healthy: health.score >= 50,
    score: health.score,
    alerts: health.alerts,
    level: health.score >= 80 ? "healthy" : health.score >= 50 ? "degraded" : health.score >= 30 ? "unhealthy" : "critical"
  };
}

/**
 * Purge old health snapshots.
 * @param {number} days - keep snapshots newer than this
 */
export function purgeHealthSnapshots(days = 30) {
  ensureTable();
  const db = getDb();
  const result = db.prepare("DELETE FROM health_snapshots WHERE timestamp < datetime('now', ?)").run(`-${days} days`);
  return result.changes;
}
