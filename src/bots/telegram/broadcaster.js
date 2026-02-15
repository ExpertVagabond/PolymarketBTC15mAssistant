/**
 * Telegram signal broadcaster: sends signal alerts to channels.
 * - Public channel: delayed signals (free tier)
 * - Private channel: real-time signals (paid tier)
 */

import { getTelegramBot } from "./bot.js";

const DELAY_FREE_MS = 5 * 60_000; // 5 minute delay for free tier
const pendingDelayed = [];

/**
 * Broadcast a signal to Telegram channels.
 * @param {object} tick - Scanner tick with an ENTER signal
 */
export async function broadcastSignal(tick) {
  const bot = getTelegramBot();
  if (!bot) return;

  // Settlement notifications use a different format
  const message = tick.signal === "SETTLED"
    ? formatSettlementMessage(tick)
    : formatSignalMessage(tick);

  // Private channel (real-time, paid subscribers)
  const privateChannelId = process.env.TELEGRAM_PRIVATE_CHANNEL_ID;
  if (privateChannelId) {
    try {
      await bot.sendMessage(privateChannelId, message, { parse_mode: "HTML" });
    } catch (err) {
      console.error("[telegram] Error sending to private channel:", err.message);
    }
  }

  // Public channel (delayed for signals, immediate for settlements)
  const publicChannelId = process.env.TELEGRAM_PUBLIC_CHANNEL_ID;
  if (publicChannelId) {
    if (tick.signal === "SETTLED") {
      try { await bot.sendMessage(publicChannelId, message, { parse_mode: "HTML" }); } catch { /* ignore */ }
    } else {
      pendingDelayed.push({ message, channelId: publicChannelId, sendAt: Date.now() + DELAY_FREE_MS });
    }
  }
}

/**
 * Process delayed messages for free tier. Call this periodically.
 */
export async function flushDelayed() {
  const bot = getTelegramBot();
  if (!bot) return;

  const now = Date.now();
  while (pendingDelayed.length > 0 && pendingDelayed[0].sendAt <= now) {
    const { message, channelId } = pendingDelayed.shift();
    try {
      await bot.sendMessage(channelId, message, { parse_mode: "HTML" });
    } catch (err) {
      console.error("[telegram] Error sending delayed message:", err.message);
    }
  }
}

function formatSignalMessage(tick) {
  const side = tick.rec.side === "UP" ? "YES" : "NO";
  const emoji = tick.rec.strength === "STRONG" ? "🔴" : tick.rec.strength === "GOOD" ? "🟡" : "🟢";
  const modelUp = (tick.timeAware.adjustedUp * 100).toFixed(1);
  const edgeUp = ((tick.edge?.edgeUp ?? 0) * 100).toFixed(1);
  const edgeDown = ((tick.edge?.edgeDown ?? 0) * 100).toFixed(1);
  const bestEdge = tick.rec.side === "UP" ? edgeUp : edgeDown;

  const priceUp = tick.prices?.up !== null ? `${(tick.prices.up * 100).toFixed(0)}¢` : "—";
  const priceDown = tick.prices?.down !== null ? `${(tick.prices.down * 100).toFixed(0)}¢` : "—";

  return (
    `${emoji} <b>BUY ${side}</b> — ${escapeHtml(tick.question?.slice(0, 60) || "Unknown")}\n` +
    `Model: UP ${modelUp}% | Edge: +${bestEdge}%\n` +
    `Market: ${priceUp} YES / ${priceDown} NO\n` +
    `Strength: ${tick.rec.strength} | Phase: ${tick.rec.phase}\n` +
    `Category: ${tick.category || "other"}`
  );
}

function formatSettlementMessage(tick) {
  const msg = tick.settlementMsg || "Market settled";
  const emoji = msg.startsWith("WIN") ? "✅" : "❌";
  return `${emoji} <b>SETTLED</b> — ${escapeHtml((tick.question || "").slice(0, 60))}\n${escapeHtml(msg)}`;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
