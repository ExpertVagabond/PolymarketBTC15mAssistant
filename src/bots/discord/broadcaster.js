/**
 * Discord signal broadcaster: posts signal embeds to channels.
 * - #free-signals: delayed, limited info
 * - #premium-signals: real-time, full detail
 */

import { EmbedBuilder } from "discord.js";
import { getDiscordClient } from "./bot.js";

const DELAY_FREE_MS = 5 * 60_000;
const pendingDelayed = [];

/**
 * Broadcast a signal to Discord channels.
 */
export async function broadcastSignal(tick) {
  const client = getDiscordClient();
  if (!client) return;

  const embed = buildSignalEmbed(tick);

  // Premium channel (real-time)
  const premiumChannelId = process.env.DISCORD_PREMIUM_CHANNEL_ID;
  if (premiumChannelId) {
    try {
      const channel = await client.channels.fetch(premiumChannelId);
      if (channel) await channel.send({ embeds: [embed] });
    } catch (err) {
      console.error("[discord] Error posting to premium channel:", err.message);
    }
  }

  // Free channel (delayed)
  const freeChannelId = process.env.DISCORD_FREE_CHANNEL_ID;
  if (freeChannelId) {
    pendingDelayed.push({ embed: buildFreeEmbed(tick), channelId: freeChannelId, sendAt: Date.now() + DELAY_FREE_MS });
  }
}

/**
 * Flush delayed messages for free channel.
 */
export async function flushDelayed() {
  const client = getDiscordClient();
  if (!client) return;

  const now = Date.now();
  while (pendingDelayed.length > 0 && pendingDelayed[0].sendAt <= now) {
    const { embed, channelId } = pendingDelayed.shift();
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel) await channel.send({ embeds: [embed] });
    } catch (err) {
      console.error("[discord] Error posting delayed message:", err.message);
    }
  }
}

function buildSignalEmbed(tick) {
  const side = tick.rec.side === "UP" ? "YES" : "NO";
  const bestEdge = tick.rec.side === "UP" ? tick.edge?.edgeUp : tick.edge?.edgeDown;
  const priceUp = tick.prices?.up !== null ? `${(tick.prices.up * 100).toFixed(0)}¢` : "—";
  const priceDown = tick.prices?.down !== null ? `${(tick.prices.down * 100).toFixed(0)}¢` : "—";

  return new EmbedBuilder()
    .setTitle(`BUY ${side} — ${tick.question?.slice(0, 60) || "Unknown"}`)
    .setColor(tick.rec.strength === "STRONG" ? 0xff0000 : 0xffaa00)
    .addFields(
      { name: "Model", value: `UP ${(tick.timeAware.adjustedUp * 100).toFixed(1)}%`, inline: true },
      { name: "Edge", value: `+${((bestEdge ?? 0) * 100).toFixed(1)}%`, inline: true },
      { name: "Strength", value: tick.rec.strength, inline: true },
      { name: "Market", value: `${priceUp} YES / ${priceDown} NO`, inline: true },
      { name: "Phase", value: tick.rec.phase, inline: true },
      { name: "Category", value: tick.category || "other", inline: true }
    )
    .setTimestamp();
}

function buildFreeEmbed(tick) {
  const side = tick.rec.side === "UP" ? "YES" : "NO";

  return new EmbedBuilder()
    .setTitle(`Signal: BUY ${side} — ${tick.question?.slice(0, 40) || "Unknown"}`)
    .setColor(0x888888)
    .setDescription(`Strength: ${tick.rec.strength} | Category: ${tick.category}\n\n_Subscribe for real-time signals with full detail._`)
    .setTimestamp();
}
