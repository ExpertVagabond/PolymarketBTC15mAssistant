/**
 * API key management for programmatic access.
 *
 * Keys are hashed (SHA-256) before storage. The raw key is only shown once
 * at creation time. Supports per-key rate limiting and plan-level access.
 *
 * Key format: pk_live_<32 hex chars>
 */

import crypto from "node:crypto";
import { getDb } from "./db.js";

let stmts = null;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT DEFAULT 'default',
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT,
      call_count INTEGER DEFAULT 0,
      revoked INTEGER DEFAULT 0
    )
  `);

  stmts = {
    insert: db.prepare("INSERT INTO api_keys (email, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)"),
    findByHash: db.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0"),
    listByEmail: db.prepare("SELECT id, name, key_prefix, created_at, last_used_at, call_count, revoked FROM api_keys WHERE email = ? ORDER BY created_at DESC"),
    revoke: db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ? AND email = ?"),
    recordUse: db.prepare("UPDATE api_keys SET last_used_at = datetime('now'), call_count = call_count + 1 WHERE key_hash = ?"),
    countByEmail: db.prepare("SELECT COUNT(*) as cnt FROM api_keys WHERE email = ? AND revoked = 0")
  };
}

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Generate a new API key for a subscriber.
 * Returns the raw key (only shown once).
 */
export function generateKey(email, name = "default") {
  if (!stmts) ensureTable();

  // Limit to 5 active keys per email
  const { cnt } = stmts.countByEmail.get(email);
  if (cnt >= 5) throw new Error("max_keys_reached");

  const rawKey = "pk_live_" + crypto.randomBytes(16).toString("hex");
  const hash = hashKey(rawKey);
  const prefix = rawKey.slice(0, 12) + "...";

  stmts.insert.run(email, name, hash, prefix);

  return { key: rawKey, prefix, name };
}

/**
 * Verify an API key and return the associated email.
 * Returns null if invalid/revoked.
 */
export function verifyKey(rawKey) {
  if (!stmts) ensureTable();
  if (!rawKey || !rawKey.startsWith("pk_live_")) return null;

  const hash = hashKey(rawKey);
  const row = stmts.findByHash.get(hash);
  if (!row) return null;

  // Record usage
  stmts.recordUse.run(hash);

  return { email: row.email, name: row.name, keyId: row.id };
}

/**
 * List all keys for a subscriber (masked).
 */
export function listKeys(email) {
  if (!stmts) ensureTable();
  return stmts.listByEmail.all(email);
}

/**
 * Revoke a key by ID (must belong to the given email).
 */
export function revokeKey(id, email) {
  if (!stmts) ensureTable();
  const result = stmts.revoke.run(id, email);
  return result.changes > 0;
}
