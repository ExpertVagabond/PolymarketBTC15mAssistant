/**
 * Trial reminder emails: notify users when their trial is about to expire.
 * Checks daily for trials expiring within 24 hours and sends a reminder via Resend.
 */

import { getDb } from "./db.js";
import { Resend } from "resend";

let resend = null;
function getResend() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

/**
 * Ensure reminder_sent column exists on subscribers table.
 */
function ensureColumns() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(subscribers)").all().map(c => c.name);
  if (!cols.includes("trial_reminder_sent")) {
    db.exec("ALTER TABLE subscribers ADD COLUMN trial_reminder_sent INTEGER DEFAULT 0");
  }
}

/**
 * Find trials expiring within the next 24 hours that haven't been reminded yet.
 */
export function getExpiringTrials() {
  ensureColumns();
  const db = getDb();
  return db.prepare(`
    SELECT email, trial_ends_at FROM subscribers
    WHERE trial_ends_at IS NOT NULL
      AND trial_reminder_sent = 0
      AND plan = 'pro'
      AND stripe_subscription_id IS NULL
      AND datetime(trial_ends_at) > datetime('now')
      AND datetime(trial_ends_at) <= datetime('now', '+24 hours')
  `).all();
}

/**
 * Send a trial expiry reminder email.
 */
async function sendTrialReminder(email, trialEndsAt) {
  const r = getResend();
  const endDate = new Date(trialEndsAt);
  const hours = Math.max(1, Math.round((endDate.getTime() - Date.now()) / (1000 * 60 * 60)));

  if (!r) {
    console.log(`[trial-reminder] Would send reminder to ${email} — trial expires in ~${hours}h`);
    return true;
  }

  try {
    const fromEmail = process.env.FROM_EMAIL || "signals@polymarket-bot.com";
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    await r.emails.send({
      from: fromEmail,
      to: email,
      subject: "Your Pro trial expires soon — Polymarket Signal Bot",
      html: `
        <h2>Your Pro trial expires in ~${hours} hours</h2>
        <p>You've been getting full access to all markets, real-time signals, and the complete dashboard.</p>
        <p>To keep Pro access, subscribe before your trial ends:</p>
        <p><a href="${appUrl}/pricing.html" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">View Plans</a></p>
        <p style="color:#666;font-size:12px;">After your trial, you'll be downgraded to the free tier (3 markets, 5-min delay).</p>
      `
    });
    return true;
  } catch (err) {
    console.error(`[trial-reminder] Failed to send to ${email}:`, err.message);
    return false;
  }
}

/**
 * Check for expiring trials and send reminders.
 * Returns count of reminders sent.
 */
export async function checkTrialReminders() {
  ensureColumns();
  const expiring = getExpiringTrials();
  if (expiring.length === 0) return 0;

  const db = getDb();
  let sent = 0;

  for (const row of expiring) {
    const ok = await sendTrialReminder(row.email, row.trial_ends_at);
    if (ok) {
      db.prepare("UPDATE subscribers SET trial_reminder_sent = 1 WHERE email = ?").run(row.email);
      sent++;
    }
  }

  if (sent > 0) console.log(`[trial-reminder] Sent ${sent} reminder(s)`);
  return sent;
}

/**
 * Start the trial reminder check interval (runs every 6 hours).
 */
export function startTrialReminderSchedule() {
  // Run once on startup (after a short delay for DB init)
  setTimeout(() => checkTrialReminders().catch(err => console.error("[trial-reminder]", err)), 10_000);

  // Then every 6 hours
  const interval = setInterval(() => {
    checkTrialReminders().catch(err => console.error("[trial-reminder]", err));
  }, 6 * 60 * 60 * 1000);

  return interval;
}
