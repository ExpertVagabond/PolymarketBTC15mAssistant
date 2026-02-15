/**
 * Discord bot core: slash commands and user interaction.
 * Uses discord.js with gateway intents.
 */

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getByDiscordId, linkDiscord, getByEmail, isPaid } from "../../subscribers/manager.js";
import { createCheckoutUrl } from "../../subscribers/stripe-webhook.js";

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

    embeds.push(new EmbedBuilder()
      .setTitle(`BUY ${side} — ${s.question?.slice(0, 50)}`)
      .setColor(s.rec.strength === "STRONG" ? 0xff0000 : 0xffaa00)
      .addFields(
        { name: "Model", value: `UP ${(s.timeAware.adjustedUp * 100).toFixed(1)}%`, inline: true },
        { name: "Edge", value: `+${((bestEdge ?? 0) * 100).toFixed(1)}%`, inline: true },
        { name: "Strength", value: s.rec.strength, inline: true },
        { name: "Category", value: s.category || "other", inline: true }
      )
    );
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
