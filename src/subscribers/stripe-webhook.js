/**
 * Stripe webhook handler.
 * Processes subscription lifecycle events and updates the subscriber DB.
 */

import Stripe from "stripe";
import {
  createSubscriber,
  activateSubscription,
  deactivateSubscription,
  setSubscriptionPastDue,
  extendSubscription,
  getByStripeCustomerId
} from "./manager.js";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/**
 * Verify and parse a Stripe webhook event.
 * @param {Buffer|string} rawBody - raw request body
 * @param {string} signature - Stripe-Signature header
 * @returns {object} Stripe event
 */
export function verifyWebhookEvent(rawBody, signature) {
  if (!stripe) throw new Error("STRIPE_SECRET_KEY not configured");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Handle a verified Stripe webhook event.
 * @param {object} event - Stripe event object
 * @returns {{ action: string, subscriber?: object }}
 */
export function handleWebhookEvent(event) {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutComplete(event.data.object);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return handleSubscriptionUpdate(event.data.object);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event.data.object);
    case "invoice.paid":
      return handleInvoicePaid(event.data.object);
    case "invoice.payment_failed":
      return handlePaymentFailed(event.data.object);
    default:
      return { action: "ignored", eventType: event.type };
  }
}

function handleCheckoutComplete(session) {
  const email = session.customer_email || session.customer_details?.email;
  const stripeCustomerId = session.customer;
  const metadata = session.metadata || {};

  if (!email || !stripeCustomerId) {
    return { action: "error", reason: "missing_email_or_customer" };
  }

  // Determine plan from price
  const plan = determinePlan(session);

  // Create or update subscriber
  const sub = createSubscriber({ email, stripeCustomerId });

  // Activate
  const activated = activateSubscription(stripeCustomerId, {
    plan,
    subscriptionId: session.subscription || null
  });

  return {
    action: "activated",
    subscriber: activated,
    telegramUserId: metadata.telegram_user_id || null,
    discordUserId: metadata.discord_user_id || null
  };
}

function handleSubscriptionUpdate(subscription) {
  const customerId = subscription.customer;
  const status = subscription.status;

  if (status === "active") {
    const plan = determinePlanFromSubscription(subscription);
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;
    const sub = activateSubscription(customerId, { plan, subscriptionId: subscription.id, expiresAt: periodEnd });
    return { action: "updated", subscriber: sub };
  }

  if (status === "past_due") {
    const sub = setSubscriptionPastDue(customerId);
    return { action: "past_due", subscriber: sub };
  }

  if (status === "canceled" || status === "unpaid") {
    const sub = deactivateSubscription(customerId);
    return { action: "deactivated", subscriber: sub };
  }

  return { action: "subscription_status_unhandled", status };
}

function handleSubscriptionDeleted(subscription) {
  const sub = deactivateSubscription(subscription.customer);
  return { action: "deactivated", subscriber: sub };
}

function handleInvoicePaid(invoice) {
  const customerId = invoice.customer;
  const periodEnd = invoice.lines?.data?.[0]?.period?.end;
  if (customerId && periodEnd) {
    const expiresAt = new Date(periodEnd * 1000).toISOString();
    const sub = extendSubscription(customerId, expiresAt);
    return { action: "extended", subscriber: sub };
  }
  return { action: "invoice_paid_no_period" };
}

function handlePaymentFailed(invoice) {
  const customerId = invoice.customer;
  if (customerId) {
    const sub = setSubscriptionPastDue(customerId);
    return { action: "payment_failed", subscriber: sub };
  }
  return { action: "payment_failed_no_customer" };
}

/* ── helpers ── */

function determinePlan(session) {
  const priceBasic = process.env.STRIPE_PRICE_BASIC || "";
  const pricePro = process.env.STRIPE_PRICE_PRO || "";
  const lineItems = session.line_items?.data || [];

  for (const item of lineItems) {
    const priceId = item.price?.id;
    if (priceId === pricePro) return "pro";
    if (priceId === priceBasic) return "basic";
  }

  // Check metadata
  if (session.metadata?.plan) return session.metadata.plan;

  return "basic"; // default
}

function determinePlanFromSubscription(subscription) {
  const priceBasic = process.env.STRIPE_PRICE_BASIC || "";
  const pricePro = process.env.STRIPE_PRICE_PRO || "";
  const items = subscription.items?.data || [];

  for (const item of items) {
    const priceId = item.price?.id;
    if (priceId === pricePro) return "pro";
    if (priceId === priceBasic) return "basic";
  }

  return "basic";
}

/**
 * Create a Stripe Checkout session URL.
 * @param {object} opts
 * @param {string} opts.priceId - Stripe Price ID
 * @param {string} opts.email - Customer email
 * @param {object} opts.metadata - Additional metadata (telegram_user_id, discord_user_id)
 * @returns {string} Checkout URL
 */
export async function createCheckoutUrl({ priceId, email = null, metadata = {} }) {
  if (!stripe) throw new Error("STRIPE_SECRET_KEY not configured");

  const appUrl = process.env.APP_URL || "http://localhost:3000";

  const params = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/subscribe/cancel`,
    metadata
  };

  if (email) params.customer_email = email;

  const session = await stripe.checkout.sessions.create(params);
  return session.url;
}
