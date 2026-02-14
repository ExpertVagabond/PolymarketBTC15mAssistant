/**
 * Single market poll loop using the core poller pattern.
 * Runs in its own async context, feeds state to a callback.
 */

import { CONFIG } from "../config.js";
import { createPoller } from "../core/poller.js";
import { createWindowTracker } from "../backtest/window-tracker.js";

export function createMarketLoop(marketConfig = {}) {
  const label = marketConfig.label || marketConfig.slug || "default";
  const poller = createPoller({
    pollIntervalMs: marketConfig.pollIntervalMs ?? CONFIG.pollIntervalMs
  });
  const windowTracker = createWindowTracker({
    csvPath: `./logs/outcomes-${label}.csv`
  });

  let latestState = null;
  let running = false;

  async function start(onTick) {
    if (running) return;
    running = true;

    // override slug if provided
    if (marketConfig.slug) {
      CONFIG.polymarket.marketSlug = marketConfig.slug;
    }

    await poller.start((state, err) => {
      if (err) {
        if (onTick) onTick(label, null, err);
        return;
      }
      latestState = state;
      windowTracker.onTick(state);
      if (onTick) onTick(label, state, null);
    });
  }

  function stop() {
    poller.stop();
    running = false;
  }

  function getLatest() {
    return latestState;
  }

  return { start, stop, getLatest, label };
}
