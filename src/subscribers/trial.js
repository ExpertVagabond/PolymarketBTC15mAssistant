/**
 * Free trial system: 7-day Pro trial for new users.
 * Stores trial_ends_at on the subscriber record.
 * Auto-downgrades after expiry via plan-gates check.
 */

import { getDb } from "./db.js";
import { getByEmail } from "./manager.js";

const TRIAL_DAYS = 7;

/**
 * Ensure the trial column exists (safe migration).
 */
function ensureTrialColumn() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(subscribers)").all().map(c => c.name);
  if (!cols.includes("trial_ends_at")) {
    db.exec("ALTER TABLE subscribers ADD COLUMN trial_ends_at TEXT");
  }
  if (!cols.includes("trial_used")) {
    db.exec("ALTER TABLE subscribers ADD COLUMN trial_used INTEGER DEFAULT 0");
  }
}

/**
 * Start a 7-day Pro trial for a subscriber.
 * Only one trial per account.
 */
export function startTrial(email) {
  ensureTrialColumn();
  const sub = getByEmail(email);
  if (!sub) return { error: "not_found" };

  // Already on a paid plan
  if (sub.plan === "basic" || sub.plan === "pro") {
    if (sub.status === "active" && !sub.trial_ends_at) {
      return { error: "already_paid", message: "You already have an active subscription." };
    }
  }

  // Check if trial already used
  if (sub.trial_used) {
    return { error: "trial_used", message: "You've already used your free trial." };
  }

  const now = new Date();
  const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  const db = getDb();
  db.prepare(`
    UPDATE subscribers
    SET plan = 'pro', status = 'active', trial_ends_at = ?, trial_used = 1
    WHERE email = ?
  `).run(trialEnd.toISOString(), email);

  return {
    ok: true,
    trialEndsAt: trialEnd.toISOString(),
    daysRemaining: TRIAL_DAYS,
    message: `Your ${TRIAL_DAYS}-day Pro trial has started!`
  };
}

/**
 * Get trial status for a subscriber.
 */
export function getTrialStatus(email) {
  ensureTrialColumn();
  const sub = getByEmail(email);
  if (!sub) return { active: false };

  if (!sub.trial_ends_at) {
    return { active: false, eligible: !sub.trial_used, plan: sub.plan };
  }

  const now = new Date();
  const endDate = new Date(sub.trial_ends_at);
  const remaining = endDate.getTime() - now.getTime();

  if (remaining <= 0) {
    return { active: false, expired: true, eligible: false, plan: sub.plan };
  }

  const daysRemaining = Math.ceil(remaining / (24 * 60 * 60 * 1000));
  return {
    active: true,
    trialEndsAt: sub.trial_ends_at,
    daysRemaining,
    plan: "pro"
  };
}

/**
 * Check if a trial has expired and downgrade if needed.
 * Called from plan-gates.js during plan extraction.
 * @returns {"pro"|null} Returns "pro" if trial is still active, null if expired/no trial
 */
export function checkTrialActive(email) {
  ensureTrialColumn();
  const sub = getByEmail(email);
  if (!sub || !sub.trial_ends_at) return null;

  const now = new Date();
  const endDate = new Date(sub.trial_ends_at);

  if (endDate.getTime() > now.getTime()) {
    return "pro"; // Trial still active
  }

  // Trial expired — downgrade if still on trial plan
  if (sub.plan === "pro" && !sub.stripe_subscription_id) {
    const db = getDb();
    db.prepare("UPDATE subscribers SET plan = 'free', trial_ends_at = NULL WHERE email = ? AND stripe_subscription_id IS NULL").run(email);
  }

  return null;
}
