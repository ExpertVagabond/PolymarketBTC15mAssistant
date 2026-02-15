/**
 * SQLite subscriber database using better-sqlite3.
 * Zero-config, synchronous, fast. Single file at ./data/subscribers.db
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = process.env.SUBSCRIBER_DB_PATH || path.join(process.cwd(), "data", "subscribers.db");

let db = null;

export function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      stripe_customer_id TEXT UNIQUE,
      stripe_subscription_id TEXT,
      telegram_user_id TEXT UNIQUE,
      discord_user_id TEXT UNIQUE,
      plan TEXT DEFAULT 'free' CHECK(plan IN ('free', 'basic', 'pro')),
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'cancelled', 'expired', 'past_due')),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscriber_id INTEGER REFERENCES subscribers(id),
      platform TEXT CHECK(platform IN ('telegram', 'discord', 'web')),
      action TEXT CHECK(action IN ('grant', 'revoke')),
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
    CREATE INDEX IF NOT EXISTS idx_subscribers_stripe ON subscribers(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS idx_subscribers_telegram ON subscribers(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_subscribers_discord ON subscribers(discord_user_id);
  `);

  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
