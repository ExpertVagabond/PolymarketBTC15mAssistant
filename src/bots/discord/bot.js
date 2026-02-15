/**
 * Discord bot core: slash commands and user interaction.
 * Uses discord.js with gateway intents.
 */

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getByDiscordId, linkDiscord, getByEmail, isPaid } from "../../subscribers/manager.js";
import { createCheckoutUrl } from "../../subscribers/stripe-webhook.js";
import { getSignalStats, getPerformanceSummary } from "../../signals/history.js";

let client = null;
let orchestrator = null;

export function getDiscordClient() {
  return client;
}

/**
 * Start the Discord bot.
 */
export async function startDiscordBot(opts = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log("[discord] DISCORD_BOT_TOKEN not set, skipping bot start");
    return null;
  }

  orchestrator = opts.orchestrator || null;

  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
  });

  client.once("ready", () => {
    console.log(`[discord] Bot ready as ${client.user.tag}`);
    registerSlashCommands(token).catch((err) => console.error("[discord] Slash command registration failed:", err.message));
  });

  client.on("interactionCreate", handleInteraction);

  await client.login(token);
  return client;
}

async function registerSlashCommands(token) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return;

  const commands = [
    new SlashCommandBuilder().setName("subscribe").setDescription("Get a subscription to premium signals"),
    new SlashCommandBuilder().setName("status").setDescription("Check your subscription status"),
    new SlashCommandBuilder().setName("signals").setDescription("View latest trading signals"),
    new SlashCommandBuilder().setName("markets").setDescription("View tracked markets"),
    new SlashCommandBuilder().setName("winrate").setDescription("View win rates by category"),
    new SlashCommandBuilder().setName("performance").setDescription("View 7-day P&L summary"),
    new SlashCommandBuilder()
      .setName("link")
      .setDescription("Link your subscription email")
      .addStringOption((opt) => opt.setName("email").setDescription("Your subscription email").setRequired(true))
  ];

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
    body: commands.map((c) => c.toJSON())
  });
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "subscribe": return handleSubscribe(interaction);
    case "status": return handleStatus(interaction);
    case "signals": return handleSignals(interaction);
    case "markets": return handleMarkets(interaction);
    case "winrate": return handleWinRate(interaction);
    case "performance": return handlePerformance(interaction);
    case "link": return handleLink(interaction);
  }
}

async function handleSubscribe(interaction) {
  const discordUserId = interaction.user.id;
  const sub = getByDiscordId(discordUserId);

  if (sub && isPaid(sub)) {
    await interaction.reply({ content: `You already have an active **${sub.plan}** subscription!`, ephemeral: true });
    return;
  }

  const priceBasic = process.env.STRIPE_PRICE_BASIC;
  const pricePro = process.env.STRIPE_PRICE_PRO;

  if (!priceBasic && !pricePro) {
    await interaction.reply({ content: "Subscriptions are not configured yet.", ephemeral: true });
    return;
  }

  const lines = [];
  if (priceBasic) {
    try {
      const url = await createCheckoutUrl({ priceId: priceBasic, metadata: { discord_user_id: discordUserId } });
      lines.push(`**Basic** ($29/mo) — All markets, real-time signals\n${url}`);
    } catch { lines.push("Basic plan: error generating link"); }
  }
  if (pricePro) {
    try {
      const url = await createCheckoutUrl({ priceId: pricePro, metadata: { discord_user_id: discordUserId } });
      lines.push(`**Pro** ($79/mo) — All markets + API + priority\n${url}`);
    } catch { lines.push("Pro plan: error generating link"); }
  }

  await interaction.reply({ content: lines.join("\n\n"), ephemeral: true });
}

async function handleStatus(interaction) {
  const sub = getByDiscordId(interaction.user.id);
  if (!sub) {
    await interaction.reply({ content: "No subscription found. Use `/link your@email.com` or `/subscribe`.", ephemeral: true });
    return;
  }

  const emoji = sub.status === "active" ? "✅" : sub.status === "past_due" ? "⚠️" : "❌";
  await interaction.reply({
    content: `${emoji} **${sub.plan}** — ${sub.status}\nEmail: ${sub.email}${sub.expires_at ? `\nExpires: ${sub.expires_at}` : ""}`,
    ephemeral: true
  });
}

async function handleSignals(interaction) {
  if (!orchestrator) {
    await interaction.reply({ content: "Scanner not running yet.", ephemeral: true });
    return;
  }

  const sub = getByDiscordId(interaction.user.id);
  const paid = sub && isPaid(sub);
  const signals = orchestrator.getActiveSignals();

  if (!signals.length) {
    await interaction.reply({ content: "No active signals right now.", ephemeral: true });
    return;
  }

  const limit = paid ? Math.min(signals.length, 5) : 1;
  const embeds = [];

  for (let i = 0; i < limit; i++) {
    const s = signals[i];
    const side = s.rec.side === "UP" ? "YES" : "NO";
    const bestEdge = s.rec.side === "UP" ? s.edge?.edgeUp : s.edge?.edgeDown;

    const embed = new EmbedBuilder()
      .setTitle(`BUY ${side} — ${s.question?.slice(0, 50)}`)
      .setColor(s.rec.strength === "STRONG" ? 0xff0000 : 0xffaa00)
      .addFields(
        { name: "Model", value: `UP ${(s.timeAware.adjustedUp * 100).toFixed(1)}%`, inline: true },
        { name: "Edge", value: `+${((bestEdge ?? 0) * 100).toFixed(1)}%`, inline: true },
        { name: "Strength", value: s.rec.strength, inline: true },
        { name: "Category", value: s.category || "other", inline: true }
      );

    if (s.confidence != null) embed.addFields({ name: "Confidence", value: `${s.confidence}/100 (${s.confidenceTier || "-"})`, inline: true });
    if (s.kelly?.betPct != null) embed.addFields({ name: "Kelly Bet", value: `${(s.kelly.betPct * 100).toFixed(1)}%`, inline: true });
    if (s.orderFlow?.pressureLabel && s.orderFlow.pressureLabel !== "NEUTRAL") {
      embed.addFields({ name: "Flow", value: `${s.orderFlow.pressureLabel.replace("_", " ")} (${s.orderFlow.flowQuality || "-"})`, inline: true });
    }

    embeds.push(embed);
  }

  const content = !paid && signals.length > 1
    ? `Showing 1 of ${signals.length} signals. Use \`/subscribe\` for full access.`
    : undefined;

  await interaction.reply({ content, embeds, ephemeral: !paid });
}

async function handleMarkets(interaction) {
  if (!orchestrator) {
    await interaction.reply({ content: "Scanner not running yet.", ephemeral: true });
    return;
  }

  const stats = orchestrator.getStats();
  const embed = new EmbedBuilder()
    .setTitle("Market Scanner")
    .setColor(0x00aa00)
    .addFields(
      { name: "Tracked", value: String(stats.tracked), inline: true },
      { name: "Active Signals", value: String(stats.withSignal), inline: true },
      { name: "Categories", value: Object.entries(stats.categories).map(([k, v]) => `${k}: ${v}`).join("\n") || "none" }
    );

  await interaction.reply({ embeds: [embed] });
}

async function handleWinRate(interaction) {
  try {
    const stats = getSignalStats();
    const embed = new EmbedBuilder()
      .setTitle("Signal Win Rates")
      .setColor(0x00aa00)
      .addFields(
        { name: "Overall", value: `${stats.winRate || "-"}% (${stats.wins}W / ${stats.losses}L)`, inline: true },
        { name: "Avg P&L", value: stats.avg_pnl != null ? stats.avg_pnl.toFixed(1) + "%" : "-", inline: true }
      );

    if (stats.byCategory?.length) {
      const catLines = stats.byCategory
        .filter(c => c.wins + c.losses > 0)
        .map(c => {
          const wr = (c.wins / (c.wins + c.losses) * 100).toFixed(0);
          return `**${c.category}**: ${wr}% (${c.wins}W/${c.losses}L)`;
        }).join("\n");
      if (catLines) embed.addFields({ name: "By Category", value: catLines });
    }

    await interaction.reply({ embeds: [embed] });
  } catch {
    await interaction.reply({ content: "No stats available yet.", ephemeral: true });
  }
}

async function handlePerformance(interaction) {
  try {
    const perf = getPerformanceSummary(7);
    const embed = new EmbedBuilder()
      .setTitle("7-Day Performance")
      .setColor(perf.total_pnl >= 0 ? 0x34d399 : 0xf87171)
      .addFields(
        { name: "Win Rate", value: `${perf.winRate || "-"}%`, inline: true },
        { name: "Total P&L", value: perf.total_pnl != null ? (perf.total_pnl >= 0 ? "+" : "") + perf.total_pnl.toFixed(1) + "%" : "-", inline: true },
        { name: "Signals", value: `${perf.wins}W / ${perf.losses}L / ${perf.total} total`, inline: true },
        { name: "Best Trade", value: perf.best_trade != null ? "+" + perf.best_trade.toFixed(1) + "%" : "-", inline: true },
        { name: "Worst Trade", value: perf.worst_trade != null ? perf.worst_trade.toFixed(1) + "%" : "-", inline: true },
        { name: "Avg Confidence", value: perf.avg_confidence != null ? String(Math.round(perf.avg_confidence)) : "-", inline: true }
      );

    await interaction.reply({ embeds: [embed] });
  } catch {
    await interaction.reply({ content: "No performance data yet.", ephemeral: true });
  }
}

async function handleLink(interaction) {
  const email = interaction.options.getString("email");
  if (!email?.includes("@")) {
    await interaction.reply({ content: "Invalid email.", ephemeral: true });
    return;
  }

  const sub = getByEmail(email);
  if (!sub) {
    await interaction.reply({ content: `No subscription for ${email}. Use \`/subscribe\` first.`, ephemeral: true });
    return;
  }

  linkDiscord(email, interaction.user.id);
  await interaction.reply({ content: `Linked! Discord connected to ${email} (${sub.plan}).`, ephemeral: true });
}

export function stopDiscordBot() {
  if (client) {
    client.destroy();
    client = null;
  }
}
