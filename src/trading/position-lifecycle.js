/**
 * Position lifecycle finite state machine.
 *
 * Manages positions through discrete states:
 *   PENDING → ENTERED → SCALING → HEDGED → PARTIAL_EXIT → CLOSED
 *
 * Each state has:
 * - Allowed transitions with guard conditions
 * - Entry/exit hooks for side effects
 * - Timeout rules (e.g., PENDING auto-cancels after 5 min)
 * - Event log for audit trail
 *
 * Replaces simple OPEN/CLOSED tracking with structured lifecycle.
 */

// In-memory position lifecycle store
const positions = {};

// State definitions with allowed transitions
const STATES = {
  PENDING:      { transitions: ["ENTERED", "CANCELLED"], timeout: 5 * 60000 },
  ENTERED:      { transitions: ["SCALING", "HEDGED", "PARTIAL_EXIT", "CLOSED"] },
  SCALING:      { transitions: ["ENTERED", "HEDGED", "PARTIAL_EXIT", "CLOSED"] },
  HEDGED:       { transitions: ["ENTERED", "PARTIAL_EXIT", "CLOSED"] },
  PARTIAL_EXIT: { transitions: ["CLOSED", "ENTERED"] },
  CLOSED:       { transitions: [] },
  CANCELLED:    { transitions: [] }
};

/**
 * Create a new position in PENDING state.
 *
 * @param {string} positionId
 * @param {object} data
 * @param {string} data.marketId
 * @param {string} data.side - YES or NO
 * @param {number} data.shares
 * @param {number} data.entryPrice
 * @param {string} data.category
 * @param {string} data.regime
 * @param {number} data.confidence
 * @returns {object} Position state
 */
export function createPosition(positionId, data = {}) {
  if (positions[positionId]) {
    return { error: "position_exists", positionId };
  }

  const now = Date.now();
  positions[positionId] = {
    id: positionId,
    state: "PENDING",
    marketId: data.marketId || "",
    side: data.side || "YES",
    initialShares: data.shares || 0,
    currentShares: data.shares || 0,
    entryPrice: data.entryPrice || 0,
    avgPrice: data.entryPrice || 0,
    category: data.category || "unknown",
    regime: data.regime || "RANGE",
    confidence: data.confidence || 0.5,
    scaleCount: 0,
    hedgeId: null,
    realizedPnl: 0,
    events: [{ state: "PENDING", timestamp: now, reason: "created" }],
    createdAt: now,
    updatedAt: now,
    closedAt: null
  };

  return getPositionState(positionId);
}

/**
 * Transition a position to a new state.
 *
 * @param {string} positionId
 * @param {string} newState
 * @param {object} opts
 * @param {string} opts.reason - Why the transition happened
 * @param {number} opts.shares - Shares involved (for scaling/partial exit)
 * @param {number} opts.price - Price of the action
 * @param {string} opts.hedgeId - Hedge position ID (for HEDGED state)
 * @returns {{ success, position }|{ error }}
 */
export function transitionPosition(positionId, newState, opts = {}) {
  const pos = positions[positionId];
  if (!pos) return { error: "position_not_found", positionId };

  const currentDef = STATES[pos.state];
  if (!currentDef) return { error: "invalid_current_state", state: pos.state };

  if (!currentDef.transitions.includes(newState)) {
    return {
      error: "invalid_transition",
      from: pos.state,
      to: newState,
      allowed: currentDef.transitions
    };
  }

  const now = Date.now();
  const prevState = pos.state;

  // Apply state-specific logic
  switch (newState) {
    case "ENTERED":
      if (prevState === "PENDING") {
        // Confirmed fill
      } else if (prevState === "SCALING") {
        // Scale complete, back to entered
      } else if (prevState === "PARTIAL_EXIT") {
        // Re-entered after partial exit
      }
      break;

    case "SCALING": {
      const addShares = opts.shares || 0;
      const addPrice = opts.price || pos.avgPrice;
      if (addShares > 0) {
        const totalCost = pos.avgPrice * pos.currentShares + addPrice * addShares;
        pos.currentShares += addShares;
        pos.avgPrice = totalCost / pos.currentShares;
        pos.scaleCount++;
      }
      break;
    }

    case "HEDGED":
      pos.hedgeId = opts.hedgeId || null;
      break;

    case "PARTIAL_EXIT": {
      const exitShares = opts.shares || Math.floor(pos.currentShares / 2);
      const exitPrice = opts.price || pos.avgPrice;
      const pnl = (exitPrice - pos.avgPrice) * exitShares * (pos.side === "YES" ? 1 : -1);
      pos.currentShares -= exitShares;
      pos.realizedPnl += pnl;
      break;
    }

    case "CLOSED": {
      const closePrice = opts.price || pos.avgPrice;
      const closePnl = (closePrice - pos.avgPrice) * pos.currentShares * (pos.side === "YES" ? 1 : -1);
      pos.realizedPnl += closePnl;
      pos.currentShares = 0;
      pos.closedAt = now;
      break;
    }

    case "CANCELLED":
      pos.currentShares = 0;
      pos.closedAt = now;
      break;
  }

  pos.state = newState;
  pos.updatedAt = now;
  pos.events.push({
    state: newState,
    from: prevState,
    timestamp: now,
    reason: opts.reason || `transition_to_${newState}`,
    shares: opts.shares,
    price: opts.price
  });

  // Keep event log trimmed
  if (pos.events.length > 50) pos.events = pos.events.slice(-50);

  return { success: true, position: getPositionState(positionId) };
}

/**
 * Get current state of a position.
 *
 * @param {string} positionId
 * @returns {object|null}
 */
export function getPositionState(positionId) {
  const pos = positions[positionId];
  if (!pos) return null;

  const stateDef = STATES[pos.state] || {};
  const isTerminal = stateDef.transitions?.length === 0;
  const ageMs = Date.now() - pos.createdAt;

  // Check timeout
  let timedOut = false;
  if (stateDef.timeout && ageMs > stateDef.timeout && !isTerminal) {
    timedOut = true;
  }

  return {
    id: pos.id,
    state: pos.state,
    isTerminal,
    timedOut,
    marketId: pos.marketId,
    side: pos.side,
    initialShares: pos.initialShares,
    currentShares: pos.currentShares,
    avgPrice: Math.round(pos.avgPrice * 10000) / 10000,
    scaleCount: pos.scaleCount,
    hedgeId: pos.hedgeId,
    realizedPnl: Math.round(pos.realizedPnl * 100) / 100,
    regime: pos.regime,
    category: pos.category,
    confidence: pos.confidence,
    allowedTransitions: stateDef.transitions || [],
    eventCount: pos.events.length,
    lastEvent: pos.events[pos.events.length - 1] || null,
    ageMinutes: Math.round(ageMs / 60000 * 10) / 10,
    createdAt: new Date(pos.createdAt).toISOString(),
    closedAt: pos.closedAt ? new Date(pos.closedAt).toISOString() : null
  };
}

/**
 * Get all active (non-terminal) positions.
 *
 * @returns {{ active: object[], summary: object }}
 */
export function getActiveLifecycles() {
  const active = [];
  const byState = {};
  let totalPnl = 0;

  for (const posId of Object.keys(positions)) {
    const state = getPositionState(posId);
    if (!state) continue;

    byState[state.state] = (byState[state.state] || 0) + 1;
    totalPnl += state.realizedPnl;

    if (!state.isTerminal) {
      active.push(state);
    }
  }

  active.sort((a, b) => b.ageMinutes - a.ageMinutes);

  // Auto-cancel timed-out PENDING positions
  const timedOut = active.filter(p => p.timedOut);
  for (const p of timedOut) {
    transitionPosition(p.id, "CANCELLED", { reason: "timeout" });
  }

  return {
    active: active.filter(p => !p.timedOut).slice(0, 30),
    summary: {
      totalTracked: Object.keys(positions).length,
      activeCount: active.length - timedOut.length,
      byState,
      timedOutCancelled: timedOut.length,
      totalRealizedPnl: Math.round(totalPnl * 100) / 100
    }
  };
}

/**
 * Get lifecycle event history for a position.
 *
 * @param {string} positionId
 * @returns {{ events: object[] }|null}
 */
export function getPositionEvents(positionId) {
  const pos = positions[positionId];
  if (!pos) return null;

  return {
    positionId,
    currentState: pos.state,
    events: pos.events.map(e => ({
      ...e,
      timestamp: new Date(e.timestamp).toISOString()
    }))
  };
}
