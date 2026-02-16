/**
 * Alert fatigue manager.
 *
 * Prevents notification overload through intelligent routing:
 * - Per-channel throttling: max alerts per hour for Telegram/email/webhook
 * - Event deduplication: suppress repeated alerts within a time window
 * - Notification coalescing: batch related events into single messages
 * - Priority escalation: high-priority events bypass throttling
 * - Fatigue scoring: track per-user alert load and suppress when high
 *
 * Integrates with existing dispatch.js and priority.js.
 */

// In-memory fatigue tracking
const fatigueState = {
  channels: {},     // channel → { sent, lastReset, suppressed }
  dedup: {},        // eventKey → lastSentTimestamp
  coalesceBuf: {},  // channel → [pending events]
  userFatigue: {}   // userId → { score, lastDecay }
};

// Channel throttle limits (per hour)
const CHANNEL_LIMITS = {
  telegram: { maxPerHour: 20, coalesceWindowMs: 60000 },
  discord: { maxPerHour: 15, coalesceWindowMs: 60000 },
  email: { maxPerHour: 5, coalesceWindowMs: 300000 },
  webhook: { maxPerHour: 50, coalesceWindowMs: 30000 }
};

// Priority levels that bypass throttling
const BYPASS_PRIORITIES = ["critical", "emergency"];

// Dedup window (suppress identical alerts within this period)
const DEDUP_WINDOW_MS = 5 * 60000; // 5 minutes

/**
 * Check if an alert should be sent or suppressed.
 *
 * @param {object} alert
 * @param {string} alert.channel - telegram, discord, email, webhook
 * @param {string} alert.type - Alert type (e.g., "circuit_break", "signal", "drawdown")
 * @param {string} alert.priority - low, medium, high, critical, emergency
 * @param {string} alert.userId - Target user/subscriber
 * @param {string} alert.marketId - Optional market context
 * @param {string} alert.message - Alert content
 * @returns {{ action: string, reason: string, coalesced: boolean }}
 */
export function evaluateAlert(alert) {
  const channel = alert.channel || "webhook";
  const priority = alert.priority || "medium";
  const now = Date.now();

  // 1. Priority bypass: critical/emergency always sent
  if (BYPASS_PRIORITIES.includes(priority)) {
    recordSent(channel, now);
    return { action: "send", reason: "priority_bypass", coalesced: false };
  }

  // 2. Deduplication check
  const dedupKey = `${channel}:${alert.type}:${alert.marketId || "global"}`;
  const lastSent = fatigueState.dedup[dedupKey] || 0;
  if (now - lastSent < DEDUP_WINDOW_MS) {
    return { action: "suppress", reason: "duplicate_within_window", coalesced: false };
  }

  // 3. Channel throttle check
  const channelState = getChannelState(channel, now);
  const limits = CHANNEL_LIMITS[channel] || CHANNEL_LIMITS.webhook;

  if (channelState.sent >= limits.maxPerHour) {
    // Throttled — try to coalesce instead
    addToCoalesceBuffer(channel, alert);
    return { action: "coalesce", reason: "channel_throttled", coalesced: true };
  }

  // 4. User fatigue check
  const userFatigue = getUserFatigue(alert.userId, now);
  if (userFatigue > 80 && priority !== "high") {
    addToCoalesceBuffer(channel, alert);
    return { action: "coalesce", reason: "user_fatigue_high", coalesced: true };
  }

  // All checks passed — send
  recordSent(channel, now);
  fatigueState.dedup[dedupKey] = now;
  incrementUserFatigue(alert.userId, priority);

  return { action: "send", reason: "passed_all_checks", coalesced: false };
}

/**
 * Flush coalesced alerts for a channel.
 * Combines buffered alerts into a single digest message.
 *
 * @param {string} channel
 * @returns {{ flushed: number, digest: object|null }}
 */
export function flushCoalesced(channel) {
  const buf = fatigueState.coalesceBuf[channel] || [];
  if (buf.length === 0) return { flushed: 0, digest: null };

  // Group by type
  const byType = {};
  for (const alert of buf) {
    const type = alert.type || "general";
    if (!byType[type]) byType[type] = [];
    byType[type].push(alert);
  }

  const digest = {
    channel,
    alertCount: buf.length,
    types: Object.entries(byType).map(([type, alerts]) => ({
      type,
      count: alerts.length,
      sample: alerts[0].message
    })),
    generatedAt: new Date().toISOString()
  };

  // Clear buffer
  fatigueState.coalesceBuf[channel] = [];

  return { flushed: buf.length, digest };
}

/**
 * Get fatigue management status.
 *
 * @returns {{ channels, userFatigue, dedupEntries, coalesceBuffers, stats }}
 */
export function getFatigueStatus() {
  const now = Date.now();
  const channels = {};

  for (const [ch, limits] of Object.entries(CHANNEL_LIMITS)) {
    const state = getChannelState(ch, now);
    channels[ch] = {
      sentThisHour: state.sent,
      limit: limits.maxPerHour,
      utilization: round3(state.sent / limits.maxPerHour),
      suppressed: state.suppressed,
      coalesceBuffer: (fatigueState.coalesceBuf[ch] || []).length
    };
  }

  // User fatigue summary
  const users = Object.entries(fatigueState.userFatigue)
    .map(([userId, data]) => ({
      userId,
      fatigueScore: Math.round(data.score),
      status: data.score > 80 ? "fatigued" : data.score > 50 ? "moderate" : "fresh"
    }))
    .sort((a, b) => b.fatigueScore - a.fatigueScore);

  // Total stats
  const totalSent = Object.values(channels).reduce((s, c) => s + c.sentThisHour, 0);
  const totalSuppressed = Object.values(channels).reduce((s, c) => s + c.suppressed, 0);
  const totalCoalesced = Object.values(channels).reduce((s, c) => s + c.coalesceBuffer, 0);

  return {
    channels,
    topUsers: users.slice(0, 10),
    dedupEntries: Object.keys(fatigueState.dedup).length,
    stats: {
      totalSentThisHour: totalSent,
      totalSuppressed,
      totalCoalesced,
      suppressionRate: totalSent + totalSuppressed > 0
        ? round3(totalSuppressed / (totalSent + totalSuppressed)) : 0,
      overallHealth: totalSuppressed > totalSent ? "overloaded"
        : totalSuppressed > totalSent * 0.3 ? "busy"
        : "healthy"
    }
  };
}

/**
 * Reset fatigue state for a channel or all channels.
 *
 * @param {string} channel - Optional, resets all if not provided
 * @returns {{ reset: boolean }}
 */
export function resetFatigue(channel) {
  if (channel) {
    fatigueState.channels[channel] = { sent: 0, lastReset: Date.now(), suppressed: 0 };
    fatigueState.coalesceBuf[channel] = [];
  } else {
    fatigueState.channels = {};
    fatigueState.coalesceBuf = {};
    fatigueState.dedup = {};
    fatigueState.userFatigue = {};
  }
  return { reset: true };
}

// Internal helpers

function getChannelState(channel, now) {
  if (!fatigueState.channels[channel]) {
    fatigueState.channels[channel] = { sent: 0, lastReset: now, suppressed: 0 };
  }
  const state = fatigueState.channels[channel];
  // Reset hourly counter
  if (now - state.lastReset > 3600000) {
    state.sent = 0;
    state.suppressed = 0;
    state.lastReset = now;
  }
  return state;
}

function recordSent(channel, now) {
  const state = getChannelState(channel, now);
  state.sent++;
}

function addToCoalesceBuffer(channel, alert) {
  if (!fatigueState.coalesceBuf[channel]) fatigueState.coalesceBuf[channel] = [];
  fatigueState.coalesceBuf[channel].push(alert);
  // Cap buffer
  if (fatigueState.coalesceBuf[channel].length > 100) {
    fatigueState.coalesceBuf[channel] = fatigueState.coalesceBuf[channel].slice(-100);
  }
  // Record suppression
  const state = getChannelState(channel, Date.now());
  state.suppressed++;
}

function getUserFatigue(userId, now) {
  if (!userId) return 0;
  if (!fatigueState.userFatigue[userId]) {
    fatigueState.userFatigue[userId] = { score: 0, lastDecay: now };
  }
  const uf = fatigueState.userFatigue[userId];
  // Decay: fatigue drops 10 points per hour
  const hoursSince = (now - uf.lastDecay) / 3600000;
  uf.score = Math.max(0, uf.score - hoursSince * 10);
  uf.lastDecay = now;
  return uf.score;
}

function incrementUserFatigue(userId, priority) {
  if (!userId) return;
  if (!fatigueState.userFatigue[userId]) {
    fatigueState.userFatigue[userId] = { score: 0, lastDecay: Date.now() };
  }
  const increment = priority === "high" ? 5 : priority === "medium" ? 3 : 1;
  fatigueState.userFatigue[userId].score = Math.min(100,
    fatigueState.userFatigue[userId].score + increment
  );
}

function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
