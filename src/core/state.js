/**
 * Global state holder with subscriber pattern.
 * Features subscribe to state changes instead of polling themselves.
 */

let _state = null;
const _history = [];
const _subscribers = [];
const MAX_HISTORY = 10_000;

export function getState() {
  return _state;
}

export function getHistory(limit = 100) {
  return _history.slice(-limit);
}

export function pushState(state) {
  _state = state;
  _history.push({ ...state, _ts: Date.now() });
  if (_history.length > MAX_HISTORY) _history.splice(0, _history.length - MAX_HISTORY);
  for (const fn of _subscribers) {
    try { fn(state); } catch { /* subscriber error — ignore */ }
  }
}

export function onStateChange(callback) {
  _subscribers.push(callback);
  return () => {
    const idx = _subscribers.indexOf(callback);
    if (idx >= 0) _subscribers.splice(idx, 1);
  };
}

export function clearHistory() {
  _history.length = 0;
}
