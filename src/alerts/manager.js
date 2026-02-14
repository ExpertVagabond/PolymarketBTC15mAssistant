/**
 * Alert manager: checks state, fires alerts when thresholds met.
 * Env: ENABLE_ALERTS=false, ALERT_TA_THRESHOLD=0.7
 */

import { sendTelegramMessage, isTelegramConfigured } from "./telegram.js";
import { sendDiscordMessage, isDiscordConfigured } from "./discord.js";
import { canAlert, markAlerted } from "./cooldown.js";

const ENABLED = (process.env.ENABLE_ALERTS || "false").toLowerCase() === "true";
const TA_THRESHOLD = Number(process.env.ALERT_TA_THRESHOLD) || 0.7;

export function isAlertsEnabled() {
  return ENABLED && (isTelegramConfigured() || isDiscordConfigured());
}

function formatAlert(state) {
  const { signal, rec, timeAware, prices, market, indicators, regimeInfo } = state;

  const side = rec.side ?? "N/A";
  const strength = rec.strength ?? "N/A";
  const phase = rec.phase ?? "N/A";
  const modelUp = timeAware?.adjustedUp ? (timeAware.adjustedUp * 100).toFixed(1) : "?";
  const modelDown = timeAware?.adjustedDown ? (timeAware.adjustedDown * 100).toFixed(1) : "?";
  const mktUp = market.up ?? "?";
  const mktDown = market.down ?? "?";
  const btcPrice = prices.spot ? `$${prices.spot.toFixed(0)}` : "?";
  const regime = regimeInfo?.regime ?? "?";
  const rsi = indicators?.rsi ? indicators.rsi.toFixed(1) : "?";

  const lines = [
    `*BTC 15m Signal: ${signal}*`,
    `Side: ${side} | Strength: ${strength} | Phase: ${phase}`,
    `Model: UP ${modelUp}% / DOWN ${modelDown}%`,
    `Market: UP ${mktUp}¢ / DOWN ${mktDown}¢`,
    `BTC: ${btcPrice} | RSI: ${rsi} | Regime: ${regime}`,
    `Slug: ${market.slug || "?"}`
  ];

  return lines.join("\n");
}

export async function checkAndAlert(state) {
  if (!ENABLED) return;
  if (!state) return;

  const { rec, timeAware, market } = state;
  const slug = market?.slug || "default";

  // fire on ENTER with STRONG or GOOD strength
  const isEnterSignal = rec.action === "ENTER" && (rec.strength === "STRONG" || rec.strength === "GOOD");

  // also fire if model probability exceeds threshold
  const highConfidence = (timeAware?.adjustedUp >= TA_THRESHOLD) || (timeAware?.adjustedDown >= TA_THRESHOLD);

  if (!isEnterSignal && !highConfidence) return;
  if (!canAlert(slug)) return;

  const text = formatAlert(state);
  markAlerted(slug);

  const results = await Promise.allSettled([
    isTelegramConfigured() ? sendTelegramMessage(text) : Promise.resolve({ ok: false }),
    isDiscordConfigured() ? sendDiscordMessage(text) : Promise.resolve({ ok: false })
  ]);

  return results.map((r) => r.status === "fulfilled" ? r.value : { ok: false, reason: r.reason?.message });
}
