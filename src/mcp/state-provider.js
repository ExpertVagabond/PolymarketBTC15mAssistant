/**
 * Background poller that feeds the MCP server with state.
 * Starts a single poller instance and caches the latest state.
 */

import { createPoller } from "../core/poller.js";
import { getState, getHistory } from "../core/state.js";
import { createWindowTracker } from "../backtest/window-tracker.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import fs from "node:fs";

let started = false;
let poller = null;
let windowTracker = null;

export function ensurePollerRunning() {
  if (started) return;
  started = true;

  applyGlobalProxyFromEnv();
  poller = createPoller();
  windowTracker = createWindowTracker();

  poller.start((state, err) => {
    if (!err && state) {
      windowTracker.onTick(state);
    }
  });
}

export function getCurrentState() {
  return getState();
}

export function getRecentHistory(limit = 100) {
  return getHistory(limit);
}

export function getBacktestSummary() {
  try {
    const raw = fs.readFileSync("./logs/backtest-results.json", "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
