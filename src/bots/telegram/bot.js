/**
 * Telegram bot core: command handling and user interaction.
 * Uses node-telegram-bot-api in polling mode.
 */

import TelegramBot from "node-telegram-bot-api";
import { getByTelegramId, linkTelegram, getByEmail, isPaid, isPro } from "../../subscribers/manager.js";
import { createCheckoutUrl } from "../../subscribers/stripe-webhook.js";
import { getSignalStats, getPerformanceSummary } from "../../signals/history.js";

let bot = null;
let orchestrator = null;

export function getTelegramBot() {
  return bot;
}

/**
 * Start the Telegram bot.
 * @param {object} opts
 * @param {object} opts.orchestrator - Scanner orchestrator instance
 */
export function startTelegramBot(opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set, skipping bot start");
    return null;
  }

  orchestrator = opts.orchestrator || null;
  bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, handleStart);
  bot.onText(/\/subscribe/, handleSubscribe);
  bot.onText(/\/status/, handleStatus);
  bot.onText(/\/signals/, handleSignals);
  bot.onText(/\/markets/, handleMarkets);
  bot.onText(/\/help/, handleHelp);
  bot.onText(/\/link (.+)/, handleLink);
  bot.onText(/\/winrate/, handleWinRate);
  bot.onText(/\/performance/, handlePerformance);

  console.log("[telegram] Bot started, polling for messages");
  return bot;
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `Welcome to Polymarket Signal Bot!\n\n` +
    `I scan ALL active Polymarket markets and send real-time trading signals.\n\n` +
    `Commands:\n` +
    `/subscribe - Get a subscription\n` +
    `/link your@email.com - Link your subscription\n` +
    `/signals - Latest strong signals\n` +
    `/markets - Active markets being tracked\n` +
    `/status - Your subscription status\n` +
    `/help - More info`
  );
}

async function handleSubscribe(msg) {
  const chatId = msg.chat.id;
  const telegramUserId = String(msg.from.id);

  const sub = getByTelegramId(telegramUserId);
  if (sub && isPaid(sub)) {
    await bot.sendMessage(chatId, `You already have an active ${sub.plan} subscription!`);
    return;
  }

  const priceBasic = process.env.STRIPE_PRICE_BASIC;
  const pricePro = process.env.STRIPE_PRICE_PRO;

  if (!priceBasic && !pricePro) {
    await bot.sendMessage(chatId, "Subscriptions are not configured yet. Contact the admin.");
    return;
  }

  const lines = ["Choose a plan:\n"];

  if (priceBasic) {
    try {
      const url = await createCheckoutUrl({
        priceId: priceBasic,
        metadata: { telegram_user_id: telegramUserId }
      });
      lines.push(`Basic ($29/mo) - All markets, real-time signals\n${url}\n`);
    } catch (err) {
      lines.push(`Basic plan: Error generating link`);
    }
  }

  if (pricePro) {
    try {
      const url = await createCheckoutUrl({
        priceId: pricePro,
        metadata: { telegram_user_id: telegramUserId }
      });
      lines.push(`Pro ($79/mo) - All markets + API access + priority\n${url}`);
    } catch (err) {
      lines.push(`Pro plan: Error generating link`);
    }
  }

  await bot.sendMessage(chatId, lines.join("\n"));
}

async function handleStatus(msg) {
  const chatId = msg.chat.id;
  const telegramUserId = String(msg.from.id);

  const sub = getByTelegramId(telegramUserId);
  if (!sub) {
    await bot.sendMessage(chatId,
      "No subscription found for your Telegram account.\n" +
      "Use /link your@email.com to connect an existing subscription, or /subscribe to get one."
    );
    return;
  }

  const statusEmoji = sub.status === "active" ? "✅" : sub.status === "past_due" ? "⚠️" : "❌";
  await bot.sendMessage(chatId,
    `${statusEmoji} Subscription Status\n\n` +
    `Plan: ${sub.plan}\n` +
    `Status: ${sub.status}\n` +
    `Email: ${sub.email}\n` +
    (sub.expires_at ? `Expires: ${sub.expires_at}\n` : "")
  );
}

async function handleSignals(msg) {
  const chatId = msg.chat.id;
  const telegramUserId = String(msg.from.id);

  // Check access
  const sub = getByTelegramId(telegramUserId);
  const paid = sub && isPaid(sub);

  if (!orchestrator) {
    await bot.sendMessage(chatId, "Scanner not running yet. Try again in a moment.");
    return;
  }

  const signals = orchestrator.getActiveSignals();
  if (!signals.length) {
    await bot.sendMessage(chatId, "No active signals right now. Markets are quiet.");
    return;
  }

  const lines = ["Active Signals:\n"];
  const limit = paid ? signals.length : 1; // Free users see 1 signal

  for (let i = 0; i < Math.min(limit, signals.length); i++) {
    const s = signals[i];
    const side = s.rec.side === "UP" ? "YES" : "NO";
    const emoji = s.rec.strength === "STRONG" ? "🔴" : "🟡";
    const bestEdge = s.rec.side === "UP" ? s.edge?.edgeUp : s.edge?.edgeDown;
    const confStr = s.confidence != null ? ` | Conf: ${s.confidence}/100` : "";
    const kellyStr = s.kelly?.betPct != null ? ` | Kelly: ${(s.kelly.betPct * 100).toFixed(1)}%` : "";
    const flowStr = s.orderFlow?.pressureLabel && s.orderFlow.pressureLabel !== "NEUTRAL"
      ? ` | Flow: ${s.orderFlow.pressureLabel.replace("_", " ")}` : "";
    lines.push(
      `${emoji} BUY ${side} — ${s.question?.slice(0, 50)}\n` +
      `Model: ${(s.timeAware.adjustedUp * 100).toFixed(1)}% | Edge: +${((bestEdge ?? 0) * 100).toFixed(1)}%\n` +
      `${s.rec.strength} | ${s.category}${confStr}${kellyStr}${flowStr}\n`
    );
  }

  if (!paid && signals.length > 1) {
    lines.push(`\n... and ${signals.length - 1} more signals. /subscribe for full access.`);
  }

  await bot.sendMessage(chatId, lines.join("\n"));
}

async function handleMarkets(msg) {
  const chatId = msg.chat.id;

  if (!orchestrator) {
    await bot.sendMessage(chatId, "Scanner not running yet.");
    return;
  }

  const stats = orchestrator.getStats();
  const state = orchestrator.getState();
  const entries = Object.values(state).slice(0, 10);

  const lines = [
    `Tracking ${stats.tracked} markets`,
    `Categories: ${Object.entries(stats.categories).map(([k, v]) => `${k}(${v})`).join(", ")}`,
    `Active signals: ${stats.withSignal}\n`
  ];

  for (const entry of entries) {
    const m = entry.market;
    const tick = entry.lastTick;
    const signal = tick?.ok && tick.rec?.action === "ENTER"
      ? `${tick.rec.side} ${tick.rec.strength}`
      : "—";
    lines.push(`• ${m.question?.slice(0, 45)} [${signal}]`);
  }

  if (stats.tracked > 10) {
    lines.push(`\n... +${stats.tracked - 10} more`);
  }

  await bot.sendMessage(chatId, lines.join("\n"));
}

async function handleLink(msg, match) {
  const chatId = msg.chat.id;
  const telegramUserId = String(msg.from.id);
  const email = match[1]?.trim();

  if (!email || !email.includes("@")) {
    await bot.sendMessage(chatId, "Usage: /link your@email.com");
    return;
  }

  const sub = getByEmail(email);
  if (!sub) {
    await bot.sendMessage(chatId, `No subscription found for ${email}. Use /subscribe first.`);
    return;
  }

  linkTelegram(email, telegramUserId);
  await bot.sendMessage(chatId, `Linked! Your Telegram is now connected to ${email} (${sub.plan} plan).`);
}

async function handleWinRate(msg) {
  const chatId = msg.chat.id;
  try {
    const stats = getSignalStats();
    const lines = [`Signal Win Rates\n`];
    lines.push(`Overall: ${stats.winRate || "-"}% (${stats.wins}W / ${stats.losses}L)`);
    lines.push(`Avg P&L: ${stats.avg_pnl != null ? stats.avg_pnl.toFixed(1) + "%" : "-"}\n`);

    if (stats.byCategory?.length) {
      lines.push("By Category:");
      for (const cat of stats.byCategory) {
        const settled = cat.wins + cat.losses;
        if (settled === 0) continue;
        const wr = (cat.wins / settled * 100).toFixed(0);
        lines.push(`  ${cat.category}: ${wr}% (${cat.wins}W/${cat.losses}L)`);
      }
    }
    await bot.sendMessage(chatId, lines.join("\n"));
  } catch {
    await bot.sendMessage(chatId, "No stats available yet.");
  }
}

async function handlePerformance(msg) {
  const chatId = msg.chat.id;
  try {
    const perf = getPerformanceSummary(7);
    const lines = [`7-Day Performance\n`];
    lines.push(`Win Rate: ${perf.winRate || "-"}% (${perf.wins}W / ${perf.losses}L)`);
    lines.push(`Total P&L: ${perf.total_pnl != null ? (perf.total_pnl >= 0 ? "+" : "") + perf.total_pnl.toFixed(1) + "%" : "-"}`);
    lines.push(`Best Trade: ${perf.best_trade != null ? "+" + perf.best_trade.toFixed(1) + "%" : "-"}`);
    lines.push(`Worst Trade: ${perf.worst_trade != null ? perf.worst_trade.toFixed(1) + "%" : "-"}`);
    lines.push(`Avg Confidence: ${perf.avg_confidence != null ? Math.round(perf.avg_confidence) : "-"}`);
    await bot.sendMessage(chatId, lines.join("\n"));
  } catch {
    await bot.sendMessage(chatId, "No performance data yet.");
  }
}

async function handleHelp(msg) {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `PolySignal Bot\n\n` +
    `Scans all active Polymarket markets (crypto, politics, sports, esports, etc.) ` +
    `and sends real-time signals when the model detects an edge.\n\n` +
    `Free: 1 signal at a time, 5-min delay\n` +
    `Basic ($29/mo): All markets, real-time\n` +
    `Pro ($79/mo): All markets + API + priority alerts\n\n` +
    `Commands:\n` +
    `/subscribe - Get a plan\n` +
    `/link email - Connect existing subscription\n` +
    `/signals - Current signals\n` +
    `/markets - What's being tracked\n` +
    `/winrate - Win rates by category\n` +
    `/performance - 7-day P&L summary\n` +
    `/status - Your plan info`
  );
}

export function stopTelegramBot() {
  if (bot) {
    bot.stopPolling();
    bot = null;
  }
}
