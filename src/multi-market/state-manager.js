/**
 * Aggregate state from multiple market loops.
 */

const marketStates = new Map();
const subscribers = [];

export function updateMarketState(label, state) {
  marketStates.set(label, { ...state, label, updatedAt: Date.now() });
  for (const fn of subscribers) {
    try { fn(label, state); } catch { /* ignore */ }
  }
}

export function getAllMarketStates() {
  return [...marketStates.entries()].map(([label, state]) => ({ label, ...state }));
}

export function getMarketState(label) {
  return marketStates.get(label) ?? null;
}

export function onMarketUpdate(callback) {
  subscribers.push(callback);
  return () => {
    const idx = subscribers.indexOf(callback);
    if (idx >= 0) subscribers.splice(idx, 1);
  };
}
