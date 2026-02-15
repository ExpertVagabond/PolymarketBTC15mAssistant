/**
 * Subscriber CRUD operations on top of the SQLite database.
 */

import { getDb } from "./db.js";

/* ── create / lookup ── */

export function createSubscriber({ email, stripeCustomerId = null }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO subscribers (email, stripe_customer_id)
    VALUES (?, ?)
    ON CONFLICT(email) DO UPDATE SET stripe_customer_id = COALESCE(excluded.stripe_customer_id, stripe_customer_id)
  `);
  const info = stmt.run(email, stripeCustomerId);
  return getSubscriber(info.lastInsertRowid || getByEmail(email)?.id);
}

export function getSubscriber(id) {
  return getDb().prepare("SELECT * FROM subscribers WHERE id = ?").get(id) || null;
}

export function getByEmail(email) {
  return getDb().prepare("SELECT * FROM subscribers WHERE email = ?").get(email) || null;
}

export function getByStripeCustomerId(customerId) {
  return getDb().prepare("SELECT * FROM subscribers WHERE stripe_customer_id = ?").get(customerId) || null;
}

export function getByTelegramId(telegramUserId) {
  return getDb().prepare("SELECT * FROM subscribers WHERE telegram_user_id = ?").get(String(telegramUserId)) || null;
}

export function getByDiscordId(discordUserId) {
  return getDb().prepare("SELECT * FROM subscribers WHERE discord_user_id = ?").get(String(discordUserId)) || null;
}

/* ── linking platform accounts ── */

export function linkTelegram(email, telegramUserId) {
  const db = getDb();
  db.prepare("UPDATE subscribers SET telegram_user_id = ? WHERE email = ?").run(String(telegramUserId), email);
  logAccess(getByEmail(email)?.id, "telegram", "grant");
  return getByEmail(email);
}

export function linkDiscord(email, discordUserId) {
  const db = getDb();
  db.prepare("UPDATE subscribers SET discord_user_id = ? WHERE email = ?").run(String(discordUserId), email);
  logAccess(getByEmail(email)?.id, "discord", "grant");
  return getByEmail(email);
}

/* ── subscription lifecycle ── */

export function activateSubscription(stripeCustomerId, { plan = "basic", subscriptionId = null, expiresAt = null } = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE subscribers
    SET plan = ?, status = 'active', stripe_subscription_id = COALESCE(?, stripe_subscription_id), expires_at = ?
    WHERE stripe_customer_id = ?
  `).run(plan, subscriptionId, expiresAt, stripeCustomerId);
  return getByStripeCustomerId(stripeCustomerId);
}

export function deactivateSubscription(stripeCustomerId) {
  const db = getDb();
  const sub = getByStripeCustomerId(stripeCustomerId);
  if (!sub) return null;

  db.prepare("UPDATE subscribers SET status = 'cancelled', plan = 'free' WHERE stripe_customer_id = ?").run(stripeCustomerId);

  if (sub.telegram_user_id) logAccess(sub.id, "telegram", "revoke");
  if (sub.discord_user_id) logAccess(sub.id, "discord", "revoke");

  return getByStripeCustomerId(stripeCustomerId);
}

export function setSubscriptionPastDue(stripeCustomerId) {
  getDb().prepare("UPDATE subscribers SET status = 'past_due' WHERE stripe_customer_id = ?").run(stripeCustomerId);
  return getByStripeCustomerId(stripeCustomerId);
}

export function extendSubscription(stripeCustomerId, expiresAt) {
  getDb().prepare("UPDATE subscribers SET status = 'active', expires_at = ? WHERE stripe_customer_id = ?").run(expiresAt, stripeCustomerId);
  return getByStripeCustomerId(stripeCustomerId);
}

/* ── access checks ── */

export function isActive(subscriberOrId) {
  const sub = typeof subscriberOrId === "object" ? subscriberOrId : getSubscriber(subscriberOrId);
  if (!sub) return false;
  if (sub.status !== "active") return false;
  if (sub.expires_at && new Date(sub.expires_at) < new Date()) return false;
  return true;
}

export function isPaid(subscriberOrId) {
  const sub = typeof subscriberOrId === "object" ? subscriberOrId : getSubscriber(subscriberOrId);
  return isActive(sub) && (sub.plan === "basic" || sub.plan === "pro");
}

export function isPro(subscriberOrId) {
  const sub = typeof subscriberOrId === "object" ? subscriberOrId : getSubscriber(subscriberOrId);
  return isActive(sub) && sub.plan === "pro";
}

/* ── stats ── */

export function getActiveCount() {
  return getDb().prepare("SELECT COUNT(*) as count FROM subscribers WHERE status = 'active'").get().count;
}

export function getStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as count FROM subscribers").get().count;
  const active = db.prepare("SELECT COUNT(*) as count FROM subscribers WHERE status = 'active'").get().count;
  const paid = db.prepare("SELECT COUNT(*) as count FROM subscribers WHERE status = 'active' AND plan IN ('basic', 'pro')").get().count;
  const pro = db.prepare("SELECT COUNT(*) as count FROM subscribers WHERE status = 'active' AND plan = 'pro'").get().count;
  const byPlatform = {
    telegram: db.prepare("SELECT COUNT(*) as count FROM subscribers WHERE telegram_user_id IS NOT NULL AND status = 'active'").get().count,
    discord: db.prepare("SELECT COUNT(*) as count FROM subscribers WHERE discord_user_id IS NOT NULL AND status = 'active'").get().count
  };
  return { total, active, paid, pro, byPlatform };
}

/* ── access log ── */

function logAccess(subscriberId, platform, action) {
  if (!subscriberId) return;
  getDb().prepare("INSERT INTO access_log (subscriber_id, platform, action) VALUES (?, ?, ?)").run(subscriberId, platform, action);
}

/* ── list ── */

export function listActiveSubscribers() {
  return getDb().prepare("SELECT * FROM subscribers WHERE status = 'active' ORDER BY created_at DESC").all();
}

export function listPaidSubscribers() {
  return getDb().prepare("SELECT * FROM subscribers WHERE status = 'active' AND plan IN ('basic', 'pro') ORDER BY created_at DESC").all();
}

/* ── admin: list all subscribers with filters ── */

export function listAllSubscribers({ plan = null, status = null, limit = 50 } = {}) {
  const db = getDb();
  let sql = "SELECT id, email, plan, status, created_at, expires_at, telegram_user_id, discord_user_id FROM subscribers WHERE 1=1";
  const params = [];
  if (plan) { sql += " AND plan = ?"; params.push(plan); }
  if (status) { sql += " AND status = ?"; params.push(status); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/* ── admin: grant complimentary access ── */

export function grantCompAccess(email, plan = "pro", days = 30) {
  const db = getDb();
  const sub = getByEmail(email);
  if (!sub) {
    // Create a new subscriber with comp access
    db.prepare("INSERT INTO subscribers (email, plan, status, expires_at) VALUES (?, ?, 'active', datetime('now', '+' || ? || ' days'))").run(email, plan, days);
    return { ok: true, email, plan, days, message: `Granted ${days}-day ${plan} access to ${email}` };
  }
  db.prepare("UPDATE subscribers SET plan = ?, status = 'active', expires_at = datetime('now', '+' || ? || ' days') WHERE email = ?").run(plan, days, email);
  return { ok: true, email, plan, days, message: `Extended ${days}-day ${plan} access for ${email}` };
}
