/**
 * Referral system: generate codes, track referrals, reward credits.
 *
 * Reward: 1 free month per 3 successful referrals.
 * Code format: PS-{8 hex chars}
 */

import { getDb as getSubDb } from "../subscribers/db.js";
import crypto from "node:crypto";

let stmts = null;

function ensureTable() {
  const db = getSubDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_email TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      referred_email TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'rewarded')),
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS referral_codes (
      email TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS referral_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      reward_type TEXT DEFAULT 'free_month',
      granted_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_email);
  `);
  stmts = {
    getCode: db.prepare("SELECT * FROM referral_codes WHERE email = ?"),
    createCode: db.prepare("INSERT INTO referral_codes (email, code) VALUES (?, ?)"),
    findCode: db.prepare("SELECT * FROM referral_codes WHERE code = ?"),
    addReferral: db.prepare("INSERT INTO referrals (referrer_email, code, referred_email, status) VALUES (?, ?, ?, 'completed')"),
    checkDuplicate: db.prepare("SELECT 1 FROM referrals WHERE referred_email = ?"),
    countCompleted: db.prepare("SELECT COUNT(*) as count FROM referrals WHERE referrer_email = ? AND status IN ('completed', 'rewarded')"),
    countRewarded: db.prepare("SELECT COUNT(*) as count FROM referral_rewards WHERE email = ?"),
    addReward: db.prepare("INSERT INTO referral_rewards (email) VALUES (?)"),
    markRewarded: db.prepare("UPDATE referrals SET status = 'rewarded' WHERE referrer_email = ? AND status = 'completed' LIMIT 3"),
    listReferrals: db.prepare("SELECT referred_email, status, completed_at FROM referrals WHERE referrer_email = ? ORDER BY created_at DESC LIMIT 20"),
    listRewards: db.prepare("SELECT * FROM referral_rewards WHERE email = ? ORDER BY granted_at DESC")
  };
}

function generateCode() {
  return "PS-" + crypto.randomBytes(4).toString("hex");
}

/**
 * Get or create a referral code for a user.
 */
export function getOrCreateReferralCode(email) {
  if (!stmts) ensureTable();
  const existing = stmts.getCode.get(email);
  if (existing) {
    const stats = getReferralStats(email);
    return { code: existing.code, ...stats };
  }

  const code = generateCode();
  stmts.createCode.run(email, code);
  return { code, completed: 0, rewards: 0, referrals: [] };
}

/**
 * Claim a referral (new user signs up with a referral code).
 */
export function claimReferral(code, referredEmail) {
  if (!stmts) ensureTable();

  // Find the referral code owner
  const codeRow = stmts.findCode.get(code);
  if (!codeRow) return { error: "invalid_code", message: "Referral code not found." };

  // Can't refer yourself
  if (codeRow.email === referredEmail) return { error: "self_referral", message: "You can't use your own referral code." };

  // Check if this user was already referred
  const dup = stmts.checkDuplicate.get(referredEmail);
  if (dup) return { error: "already_referred", message: "This account has already been referred." };

  // Record the referral
  stmts.addReferral.run(codeRow.email, code, referredEmail);

  // Check if reward threshold reached (every 3 referrals)
  const completed = stmts.countCompleted.get(codeRow.email).count;
  const rewarded = stmts.countRewarded.get(codeRow.email).count;
  const pendingRewards = Math.floor(completed / 3) - rewarded;

  if (pendingRewards > 0) {
    stmts.addReward.run(codeRow.email);
    // Mark 3 referrals as rewarded
    getSubDb().prepare("UPDATE referrals SET status = 'rewarded' WHERE referrer_email = ? AND status = 'completed' ORDER BY created_at ASC LIMIT 3").run(codeRow.email);
  }

  return { ok: true, message: "Referral recorded! Thanks for joining via a friend." };
}

/**
 * Get referral stats for a user.
 */
export function getReferralStats(email) {
  if (!stmts) ensureTable();
  const completed = stmts.countCompleted.get(email)?.count || 0;
  const rewards = stmts.countRewarded.get(email)?.count || 0;
  const referrals = stmts.listReferrals.all(email);
  const rewardList = stmts.listRewards.all(email);
  const untilNextReward = 3 - (completed % 3);

  return {
    completed,
    rewards,
    untilNextReward: untilNextReward === 3 ? 0 : untilNextReward,
    referrals,
    rewardHistory: rewardList
  };
}
