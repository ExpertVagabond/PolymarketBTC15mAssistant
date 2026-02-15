/**
 * Runtime trading configuration: SQLite-backed, changeable via API without restart.
 * Falls back to environment variables if no DB config exists.
 */

import { getDb } from "../subscribers/db.js";
import { logAuditEvent } from "./audit-log.js";
import { broadcastTradeEvent } from "../web/ws-handler.js";

let initialized = false;

// Default values (from env vars or hardcoded fallbacks)
const DEFAULTS = {
  max_bet_usd: Number(process.env.MAX_BET_USD) || 1,
  daily_loss_limit_usd: Number(process.env.DAILY_LOSS_LIMIT_USD) || 10,
  max_open_positions: Number(process.env.MAX_OPEN_POSITIONS) || 3,
  take_profit_pct: Number(process.env.TAKE_PROFIT_PCT) || 15,
  stop_loss_pct: Number(process.env.STOP_LOSS_PCT) || -10,
  max_total_exposure_usd: Number(process.env.MAX_TOTAL_EXPOSURE_USD) || 50,
  max_category_concentration_pct: Number(process.env.MAX_CATEGORY_CONCENTRATION_PCT) || 50,
  max_slippage_pct: Number(process.env.MAX_SLIPPAGE_PCT) || 2,
  min_balance_usd: Number(process.env.MIN_BALANCE_USD) || 1,
  trailing_stop_pct: Number(process.env.TRAILING_STOP_PCT) || 5,
  breakeven_trigger_pct: Number(process.env.BREAKEVEN_TRIGGER_PCT) || 8,
  max_hold_hours: Number(process.env.MAX_HOLD_HOURS) || 48,
  min_settlement_minutes: Number(process.env.MIN_SETTLEMENT_MINUTES) || 30,
  max_spread: Number(process.env.MAX_SPREAD) || 0.05
};

// Allowed config keys and their validation rules
const CONFIG_RULES = {
  max_bet_usd: { min: 0.1, max: 1000, type: "number" },
  daily_loss_limit_usd: { min: 1, max: 10000, type: "number" },
  max_open_positions: { min: 1, max: 50, type: "integer" },
  take_profit_pct: { min: 1, max: 500, type: "number" },
  stop_loss_pct: { min: -100, max: -1, type: "number" },
  max_total_exposure_usd: { min: 1, max: 100000, type: "number" },
  max_category_concentration_pct: { min: 10, max: 100, type: "number" },
  max_slippage_pct: { min: 0.1, max: 20, type: "number" },
  min_balance_usd: { min: 0, max: 10000, type: "number" },
  trailing_stop_pct: { min: 1, max: 50, type: "number" },
  breakeven_trigger_pct: { min: 1, max: 100, type: "number" },
  max_hold_hours: { min: 1, max: 720, type: "number" },
  min_settlement_minutes: { min: 1, max: 10080, type: "number" },
  max_spread: { min: 0.001, max: 0.5, type: "number" }
};

let _config = { ...DEFAULTS };

function ensureTable() {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trading_config (
      key TEXT PRIMARY KEY,
      value REAL NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT
    )
  `);
  initialized = true;
}

/**
 * Load config from DB, falling back to defaults for missing keys.
 */
function loadConfig() {
  ensureTable();
  const rows = getDb().prepare("SELECT key, value FROM trading_config").all();
  _config = { ...DEFAULTS };
  for (const row of rows) {
    if (row.key in DEFAULTS) {
      _config[row.key] = row.value;
    }
  }
}

let loaded = false;
function ensureLoaded() {
  if (!loaded) { loadConfig(); loaded = true; }
}

/**
 * Get a single config value.
 */
export function getConfigValue(key) {
  ensureLoaded();
  return _config[key] ?? DEFAULTS[key];
}

/**
 * Get all trading config values.
 */
export function getTradingConfig() {
  ensureLoaded();
  return { ...DEFAULTS, ..._config };
}

/**
 * Update one or more config values.
 * @param {object} updates - { key: value, ... }
 * @param {string} updatedBy - who made the change (email or "system")
 * @returns {{ ok, updated, errors }}
 */
export function updateTradingConfig(updates, updatedBy = "admin") {
  ensureLoaded();
  const errors = [];
  const warnings = [];
  const updated = {};

  // Fetch current state for constraint checks
  let currentOpenPositions = 0;
  let currentExposure = 0;
  try {
    const row = getDb().prepare("SELECT COUNT(*) as count FROM trade_executions WHERE status = 'open'").get();
    currentOpenPositions = row?.count || 0;
    const expRow = getDb().prepare("SELECT SUM(amount) as total FROM trade_executions WHERE status = 'open'").get();
    currentExposure = expRow?.total || 0;
  } catch { /* tables may not exist yet */ }

  for (const [key, rawValue] of Object.entries(updates)) {
    const rule = CONFIG_RULES[key];
    if (!rule) { errors.push({ key, error: "unknown_key" }); continue; }

    const value = Number(rawValue);
    if (isNaN(value)) { errors.push({ key, error: "not_a_number" }); continue; }
    if (rule.type === "integer" && !Number.isInteger(value)) { errors.push({ key, error: "must_be_integer" }); continue; }
    if (value < rule.min || value > rule.max) { errors.push({ key, error: `out_of_range (${rule.min}-${rule.max})` }); continue; }

    // State-aware constraint warnings
    if (key === "max_open_positions" && value < currentOpenPositions) {
      warnings.push({ key, warning: `Currently ${currentOpenPositions} open positions — new limit ${value} won't close existing, but blocks new trades` });
    }
    if (key === "max_total_exposure_usd" && value < currentExposure) {
      warnings.push({ key, warning: `Current exposure $${currentExposure.toFixed(2)} exceeds new limit $${value} — blocks new trades until exposure reduces` });
    }

    const oldValue = _config[key];
    _config[key] = value;

    getDb().prepare(
      "INSERT INTO trading_config (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now'), updated_by = ?"
    ).run(key, value, updatedBy, value, updatedBy);

    updated[key] = { old: oldValue, new: value };
  }

  if (Object.keys(updated).length > 0) {
    logAuditEvent("CONFIG_CHANGE", { detail: { updated, by: updatedBy } });
    try { broadcastTradeEvent("CONFIG_CHANGE", { changes: updated, by: updatedBy }); } catch { /* non-fatal */ }
  }

  return {
    ok: errors.length === 0,
    updated,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/**
 * Get config with metadata (for admin display).
 */
export function getTradingConfigDetailed() {
  ensureLoaded();
  const rows = getDb().prepare("SELECT key, value, updated_at, updated_by FROM trading_config").all();
  const dbMap = {};
  for (const row of rows) { dbMap[row.key] = row; }

  const result = {};
  for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
    const rule = CONFIG_RULES[key];
    const dbRow = dbMap[key];
    result[key] = {
      value: _config[key],
      default: defaultValue,
      isCustom: dbRow != null,
      updatedAt: dbRow?.updated_at || null,
      updatedBy: dbRow?.updated_by || null,
      min: rule?.min,
      max: rule?.max
    };
  }
  return result;
}
