/**
 * Strategy library — save, load, and compare backtested strategies.
 * Each strategy is a named set of simulator filters persisted in SQLite.
 */

import { getDb } from "../subscribers/db.js";
import { simulateStrategy } from "../signals/history.js";

let stmts = null;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      filters TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_strategies_name ON strategies(name);
  `);

  stmts = {
    insert: db.prepare("INSERT INTO strategies (name, description, filters) VALUES (@name, @description, @filters)"),
    getAll: db.prepare("SELECT * FROM strategies ORDER BY updated_at DESC"),
    getById: db.prepare("SELECT * FROM strategies WHERE id = ?"),
    update: db.prepare("UPDATE strategies SET name = @name, description = @description, filters = @filters, updated_at = datetime('now') WHERE id = @id"),
    remove: db.prepare("DELETE FROM strategies WHERE id = ?")
  };
}

/**
 * Save a new strategy.
 * @param {string} name
 * @param {object} filters - Simulator filter params
 * @param {string} description
 * @returns {{ id: number }}
 */
export function saveStrategy(name, filters, description = "") {
  if (!stmts) ensureTable();
  if (!name || typeof name !== "string") throw new Error("name_required");
  const result = stmts.insert.run({
    name: name.slice(0, 100),
    description: (description || "").slice(0, 500),
    filters: JSON.stringify(filters || {})
  });
  return { id: result.lastInsertRowid };
}

/**
 * List all saved strategies.
 */
export function listStrategies() {
  if (!stmts) ensureTable();
  return stmts.getAll.all().map(row => ({
    ...row,
    filters: JSON.parse(row.filters || "{}")
  }));
}

/**
 * Get a single strategy by ID.
 */
export function getStrategy(id) {
  if (!stmts) ensureTable();
  const row = stmts.getById.get(id);
  if (!row) return null;
  return { ...row, filters: JSON.parse(row.filters || "{}") };
}

/**
 * Update a strategy.
 */
export function updateStrategy(id, { name, filters, description }) {
  if (!stmts) ensureTable();
  const existing = stmts.getById.get(id);
  if (!existing) throw new Error("not_found");
  stmts.update.run({
    id,
    name: (name || existing.name).slice(0, 100),
    description: (description ?? (existing.description || "")).slice(0, 500),
    filters: JSON.stringify(filters || JSON.parse(existing.filters || "{}"))
  });
}

/**
 * Delete a strategy.
 */
export function deleteStrategy(id) {
  if (!stmts) ensureTable();
  return stmts.remove.run(id).changes > 0;
}

/**
 * Backtest a saved strategy and return results.
 */
export function backtestStrategy(id) {
  const strat = getStrategy(id);
  if (!strat) throw new Error("not_found");
  return { strategy: strat, results: simulateStrategy(strat.filters) };
}

/**
 * Compare two strategies side by side.
 */
export function compareStrategies(idA, idB) {
  const a = backtestStrategy(idA);
  const b = backtestStrategy(idB);
  return { a, b };
}
