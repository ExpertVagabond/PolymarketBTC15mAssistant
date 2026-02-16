/**
 * Notification priority scoring engine.
 *
 * Assigns priority levels (critical / high / medium / low) to events
 * based on signal quality, edge, confidence, and event type.
 *
 * Critical events bypass throttle limits entirely.
 * High events get a higher throttle ceiling (3x normal).
 * Low events are always batched into digest.
 */

// Priority levels with throttle multipliers
const PRIORITY_LEVELS = {
  critical: { level: 4, label: "critical", throttleMultiplier: Infinity, color: "#f87171" },
  high:     { level: 3, label: "high",     throttleMultiplier: 3,        color: "#fbbf24" },
  medium:   { level: 2, label: "medium",   throttleMultiplier: 1,        color: "#60a5fa" },
  low:      { level: 1, label: "low",      throttleMultiplier: 0,        color: "#6b7280" }  // 0 = always digest
};

// Events that are always critical regardless of data
const CRITICAL_EVENTS = new Set([
  "risk.circuit_breaker",
  "trade.fill_error",
  "risk.clob_unreachable",
  "bot.state_change"
]);

// Events that are always high priority
const HIGH_EVENTS = new Set([
  "trade.rejected",
  "trade.fill_failed",
  "risk.blocked",
  "config.changed"
]);

/**
 * Score the priority of a notification event.
 *
 * @param {string} eventType - e.g. "signal.enter", "trade.opened", "risk.circuit_breaker"
 * @param {object} data - Event data (edge, confidence, pnlUsd, amount, etc.)
 * @returns {{ priority: string, level: number, throttleMultiplier: number, reason: string }}
 */
export function scorePriority(eventType, data = {}) {
  // Critical system events
  if (CRITICAL_EVENTS.has(eventType)) {
    return { ...PRIORITY_LEVELS.critical, reason: `critical event: ${eventType}` };
  }

  // High-priority system events
  if (HIGH_EVENTS.has(eventType)) {
    return { ...PRIORITY_LEVELS.high, reason: `high-priority event: ${eventType}` };
  }

  // Trade events — score by P&L magnitude and amount
  if (eventType.startsWith("trade.")) {
    return scoreTradeEvent(eventType, data);
  }

  // Signal events — score by edge and confidence
  if (eventType.startsWith("signal.")) {
    return scoreSignalEvent(eventType, data);
  }

  // Default: medium
  return { ...PRIORITY_LEVELS.medium, reason: "default" };
}

function scoreTradeEvent(eventType, data) {
  const pnl = Math.abs(data.pnlUsd || 0);
  const amount = data.amount || 0;

  // Large P&L outcome (> $50) → high
  if (pnl > 50) {
    return { ...PRIORITY_LEVELS.high, reason: `large P&L: $${pnl.toFixed(2)}` };
  }

  // Large trade amount (> $100) → high
  if (amount > 100) {
    return { ...PRIORITY_LEVELS.high, reason: `large trade: $${amount.toFixed(2)}` };
  }

  // Position closed with significant loss → high
  if (eventType === "trade.closed" && (data.pnlUsd || 0) < -20) {
    return { ...PRIORITY_LEVELS.high, reason: `significant loss: $${(data.pnlUsd || 0).toFixed(2)}` };
  }

  // Normal trade events → medium
  return { ...PRIORITY_LEVELS.medium, reason: "standard trade event" };
}

function scoreSignalEvent(eventType, data) {
  const edge = data.edge || 0;
  const confidence = data.confidence || 0;

  // Very high edge (> 15%) → high
  if (edge > 0.15) {
    return { ...PRIORITY_LEVELS.high, reason: `high edge: ${(edge * 100).toFixed(1)}%` };
  }

  // High confidence (> 80) with decent edge → high
  if (confidence > 80 && edge > 0.08) {
    return { ...PRIORITY_LEVELS.high, reason: `strong signal: conf=${confidence}, edge=${(edge * 100).toFixed(1)}%` };
  }

  // Low confidence (< 40) → low (digest only)
  if (confidence < 40) {
    return { ...PRIORITY_LEVELS.low, reason: `low confidence: ${confidence}` };
  }

  // Low edge (< 3%) → low
  if (edge < 0.03) {
    return { ...PRIORITY_LEVELS.low, reason: `low edge: ${(edge * 100).toFixed(1)}%` };
  }

  // Normal signals → medium
  return { ...PRIORITY_LEVELS.medium, reason: "standard signal" };
}

/**
 * Check if a priority level should bypass throttle.
 * @param {string} priority - "critical", "high", "medium", "low"
 * @param {number} currentCount - current notifications sent this window
 * @param {number} maxPerHour - base throttle limit
 * @returns {boolean} true if the notification should be sent
 */
export function shouldBypassThrottle(priority, currentCount, maxPerHour) {
  const config = PRIORITY_LEVELS[priority];
  if (!config) return currentCount < maxPerHour;

  // Critical always sends
  if (config.throttleMultiplier === Infinity) return true;

  // Low always goes to digest
  if (config.throttleMultiplier === 0) return false;

  // Apply multiplier to limit
  return currentCount < (maxPerHour * config.throttleMultiplier);
}

/**
 * Get all priority level definitions.
 */
export function getPriorityLevels() {
  return { ...PRIORITY_LEVELS };
}
