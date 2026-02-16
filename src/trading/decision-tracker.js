/**
 * Decision causality tracker.
 *
 * For each signal processed by the scanner-trader pipeline, logs the
 * full decision tree: which gates passed, which blocked, raw scores,
 * and why the final decision was made.
 *
 * Tracks "near misses" — signals that passed all filters but one.
 * Enables post-hoc analysis of filter tightness and counterfactual P&L.
 */

import { getDb } from "../subscribers/db.js";

let stmts = null;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      market_id TEXT,
      question TEXT,
      category TEXT,
      side TEXT,
      outcome TEXT NOT NULL,
      blocking_gate TEXT,
      gates_passed INTEGER DEFAULT 0,
      gates_total INTEGER DEFAULT 0,
      near_miss INTEGER DEFAULT 0,
      scores TEXT,
      gate_details TEXT,
      signal_data TEXT
    )
  `);

  stmts = {
    insert: db.prepare(`
      INSERT INTO decision_log (market_id, question, category, side, outcome, blocking_gate, gates_passed, gates_total, near_miss, scores, gate_details, signal_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    recent: db.prepare(`
      SELECT * FROM decision_log ORDER BY timestamp DESC LIMIT ?
    `),
    nearMisses: db.prepare(`
      SELECT * FROM decision_log WHERE near_miss = 1 AND timestamp > datetime('now', ?) ORDER BY timestamp DESC LIMIT ?
    `),
    filterCounts: db.prepare(`
      SELECT blocking_gate, COUNT(*) as count FROM decision_log
      WHERE outcome = 'blocked' AND timestamp > datetime('now', ?)
      GROUP BY blocking_gate ORDER BY count DESC
    `),
    outcomeByGate: db.prepare(`
      SELECT blocking_gate, COUNT(*) as blocked,
        (SELECT COUNT(*) FROM decision_log d2 WHERE d2.outcome = 'executed' AND d2.timestamp > datetime('now', ?)) as executed
      FROM decision_log
      WHERE outcome = 'blocked' AND timestamp > datetime('now', ?)
      GROUP BY blocking_gate
    `)
  };
}

/**
 * Log a decision for a signal that went through the pipeline.
 *
 * @param {object} params
 * @param {string} params.marketId
 * @param {string} params.question
 * @param {string} params.category
 * @param {string} params.side
 * @param {string} params.outcome - "executed", "blocked", "dry_run"
 * @param {string|null} params.blockingGate - which gate blocked (null if executed)
 * @param {object} params.gates - { dedup: bool, cooldown: bool, correlation: bool, ... }
 * @param {object} params.scores - { quality, confidence, edge, regime, ... }
 * @param {object} params.signalData - raw tick data subset
 */
export function logDecision({ marketId, question, category, side, outcome, blockingGate, gates = {}, scores = {}, signalData = {} }) {
  if (!stmts) ensureTable();

  const gateEntries = Object.entries(gates);
  const gatesPassed = gateEntries.filter(([, v]) => v === true).length;
  const gatesTotal = gateEntries.length;
  const nearMiss = outcome === "blocked" && gatesPassed >= gatesTotal - 1 ? 1 : 0;

  stmts.insert.run(
    marketId || null,
    question ? question.slice(0, 200) : null,
    category || null,
    side || null,
    outcome,
    blockingGate || null,
    gatesPassed,
    gatesTotal,
    nearMiss,
    JSON.stringify(scores),
    JSON.stringify(gates),
    JSON.stringify({
      edge: signalData.edge,
      confidence: signalData.confidence,
      strength: signalData.strength,
      regime: signalData.regime,
      quality: signalData.quality
    })
  );
}

/**
 * Get recent decision history.
 * @param {number} limit
 */
export function getDecisionHistory(limit = 50) {
  if (!stmts) ensureTable();
  return stmts.recent.all(Math.min(limit, 500)).map(parseRow);
}

/**
 * Get near misses — signals that failed by exactly one gate.
 * @param {number} days
 * @param {number} limit
 */
export function getNearMisses(days = 7, limit = 50) {
  if (!stmts) ensureTable();
  return stmts.nearMisses.all(`-${days} days`, Math.min(limit, 200)).map(parseRow);
}

/**
 * Analyze filter cost — how many signals each gate is blocking.
 * @param {number} days
 */
export function getFilterCostAnalysis(days = 7) {
  if (!stmts) ensureTable();

  const filterCounts = stmts.filterCounts.all(`-${days} days`);
  const outcomeByGate = stmts.outcomeByGate.all(`-${days} days`, `-${days} days`);

  const totalExecuted = outcomeByGate.length > 0 ? outcomeByGate[0].executed : 0;
  const totalBlocked = filterCounts.reduce((s, f) => s + f.count, 0);

  return {
    days,
    totalExecuted,
    totalBlocked,
    passRate: (totalExecuted + totalBlocked) > 0
      ? Math.round((totalExecuted / (totalExecuted + totalBlocked)) * 10000) / 100
      : 0,
    byGate: filterCounts.map(f => ({
      gate: f.blocking_gate,
      blocked: f.count,
      pctOfTotal: totalBlocked > 0 ? Math.round((f.count / totalBlocked) * 10000) / 100 : 0
    }))
  };
}

function parseRow(row) {
  return {
    ...row,
    scores: row.scores ? JSON.parse(row.scores) : null,
    gate_details: row.gate_details ? JSON.parse(row.gate_details) : null,
    signal_data: row.signal_data ? JSON.parse(row.signal_data) : null,
    near_miss: !!row.near_miss
  };
}
