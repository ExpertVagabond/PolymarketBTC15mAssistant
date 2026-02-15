/**
 * Discord access control: manage Premium role based on subscription.
 */

import { getDiscordClient } from "./bot.js";
import { listPaidSubscribers, isPaid } from "../../subscribers/manager.js";

/**
 * Grant Premium role to a Discord user.
 */
export async function grantPremiumRole(discordUserId) {
  const client = getDiscordClient();
  const guildId = process.env.DISCORD_GUILD_ID;
  const roleId = process.env.DISCORD_PREMIUM_ROLE_ID;
  if (!client || !guildId || !roleId) return false;

  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    await member.roles.add(roleId);
    return true;
  } catch (err) {
    console.error("[discord-access] Error granting role:", err.message);
    return false;
  }
}

/**
 * Revoke Premium role from a Discord user.
 */
export async function revokePremiumRole(discordUserId) {
  const client = getDiscordClient();
  const guildId = process.env.DISCORD_GUILD_ID;
  const roleId = process.env.DISCORD_PREMIUM_ROLE_ID;
  if (!client || !guildId || !roleId) return false;

  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    await member.roles.remove(roleId);
    return true;
  } catch (err) {
    console.error("[discord-access] Error revoking role:", err.message);
    return false;
  }
}

/**
 * Sweep: verify all Premium role holders have active subscriptions.
 */
export async function sweepPremiumMembers() {
  const client = getDiscordClient();
  const guildId = process.env.DISCORD_GUILD_ID;
  const roleId = process.env.DISCORD_PREMIUM_ROLE_ID;
  if (!client || !guildId || !roleId) return { checked: 0, revoked: 0 };

  const paidSubs = listPaidSubscribers().filter((s) => s.discord_user_id);
  let revoked = 0;

  for (const sub of paidSubs) {
    if (!isPaid(sub)) {
      await revokePremiumRole(sub.discord_user_id);
      revoked++;
    }
  }

  return { checked: paidSubs.length, revoked };
}
