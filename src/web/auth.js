/**
 * Web auth: magic link email login + JWT session cookies.
 * Uses Resend for email delivery, jsonwebtoken for tokens.
 */

import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { getByEmail, createSubscriber } from "../subscribers/manager.js";
import { claimReferral } from "../referrals/tracker.js";

const JWT_SECRET = process.env.JWT_SECRET || "polymarket-signal-bot-dev-secret";
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days
const MAGIC_LINK_TTL = 15 * 60; // 15 minutes

let resend = null;
function getResend() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

/**
 * Send a magic link email.
 * @param {string} email
 * @param {string} [refCode] - Optional referral code to auto-claim on verify
 * @returns {{ ok: boolean, error?: string }}
 */
export async function sendMagicLink(email, refCode) {
  const r = getResend();

  const payload = { email, purpose: "magic_link" };
  if (refCode) payload.ref = refCode;
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: MAGIC_LINK_TTL });
  const link = `${APP_URL}/auth/verify?token=${encodeURIComponent(token)}`;

  // Ensure subscriber exists (free tier by default)
  createSubscriber({ email });

  if (!r) {
    // Dev mode: log the link
    console.log(`[auth] Magic link for ${email}: ${link}`);
    return { ok: true, devLink: link };
  }

  try {
    const fromEmail = process.env.FROM_EMAIL || "signals@polymarket-bot.com";
    await r.emails.send({
      from: fromEmail,
      to: email,
      subject: "Sign in to Polymarket Signal Bot",
      html: `
        <h2>Sign in to Polymarket Signal Bot</h2>
        <p>Click the link below to sign in. This link expires in 15 minutes.</p>
        <p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Sign In</a></p>
        <p style="color:#666;font-size:12px;">If you didn't request this, ignore this email.</p>
      `
    });
    return { ok: true };
  } catch (err) {
    console.error("[auth] Email send failed:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Verify a magic link token and return a session token.
 */
export function verifyMagicLink(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.purpose !== "magic_link") return { ok: false, error: "invalid_token_purpose" };

    const sub = getByEmail(payload.email);
    if (!sub) return { ok: false, error: "subscriber_not_found" };

    // Auto-claim referral if ref code was embedded in the magic link
    let referralResult = null;
    if (payload.ref) {
      try {
        referralResult = claimReferral(payload.ref, payload.email);
      } catch { /* non-fatal */ }
    }

    const sessionToken = jwt.sign(
      { email: payload.email, subscriberId: sub.id, plan: sub.plan },
      JWT_SECRET,
      { expiresIn: SESSION_TTL }
    );

    return { ok: true, sessionToken, subscriber: sub, referralResult };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Verify a session cookie/token.
 */
export function verifySession(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.email) return null;
    return { email: payload.email, subscriberId: payload.subscriberId, plan: payload.plan };
  } catch {
    return null;
  }
}

/**
 * Fastify preHandler hook: require authentication.
 */
export function requireAuth(request, reply, done) {
  const token = parseCookie(request.headers.cookie, "session") || request.headers.authorization?.replace("Bearer ", "");
  const session = token ? verifySession(token) : null;

  if (!session) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }

  request.session = session;
  done();
}

/**
 * Fastify preHandler hook: require paid subscription.
 */
export function requireSubscription(request, reply, done) {
  requireAuth(request, reply, () => {
    if (!request.session) return; // already replied 401
    const plan = request.session.plan;
    if (plan !== "basic" && plan !== "pro") {
      reply.code(403).send({ error: "subscription_required" });
      return;
    }
    done();
  });
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
