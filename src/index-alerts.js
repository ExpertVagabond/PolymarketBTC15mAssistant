#!/usr/bin/env node
/**
 * Console view + alerts entry point.
 * Same as npm start but with alert checking on each tick.
 * Env: ENABLE_ALERTS=true, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DISCORD_WEBHOOK_URL
 */

import { CONFIG } from "./config.js";
import { formatNumber, formatPct } from "./utils.js";
import { createPoller } from "./core/poller.js";
import { createWindowTracker } from "./backtest/window-tracker.js";
import { checkAndAlert, isAlertsEnabled } from "./alerts/manager.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

applyGlobalProxyFromEnv();

console.log(`Alerts ${isAlertsEnabled() ? "ENABLED" : "DISABLED (set ENABLE_ALERTS=true)"}`);

const poller = createPoller();
const windowTracker = createWindowTracker();

await poller.start(async (state, err) => {
  if (err) {
    console.log(`Error: ${err.message}`);
    return;
  }

  windowTracker.onTick(state);
  await checkAndAlert(state);

  // simple log line per tick
  const ts = new Date().toISOString().slice(11, 19);
  const sig = state.signal;
  const btc = state.prices?.spot ? `$${formatNumber(state.prices.spot, 0)}` : "?";
  const up = state.timeAware?.adjustedUp ? (state.timeAware.adjustedUp * 100).toFixed(0) : "?";
  const dn = state.timeAware?.adjustedDown ? (state.timeAware.adjustedDown * 100).toFixed(0) : "?";
  console.log(`[${ts}] ${sig.padEnd(10)} BTC: ${btc} UP: ${up}% DN: ${dn}% ${state.regimeInfo?.regime}`);
});
