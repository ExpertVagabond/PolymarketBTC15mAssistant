/**
 * Telegram access control: manage private channel membership.
 * Grant/revoke based on subscription status.
 */

import { getTelegramBot } from "./bot.js";
import { listPaidSubscribers, isPaid, getByTelegramId } from "../../subscribers/manager.js";

/**
 * Grant private channel access to a Telegram user.
 * Sends them a join link via DM.
 */
export async function grantChannelAccess(telegramUserId) {
  const bot = getTelegramBot();
  const channelId = process.env.TELEGRAM_PRIVATE_CHANNEL_ID;
  if (!bot || !channelId) return false;

  try {
    // Create a single-use invite link (expires in 1 hour)
    const link = await bot.createChatInviteLink(channelId, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 3600
    });

    await bot.sendMessage(telegramUserId,
      `Your subscription is active! Join the premium signals channel:\n${link.invite_link}`
    );
    return true;
  } catch (err) {
    console.error("[telegram-access] Error granting access:", err.message);
    return false;
  }
}

/**
 * Revoke private channel access (kick user from channel).
 */
export async function revokeChannelAccess(telegramUserId) {
  const bot = getTelegramBot();
  const channelId = process.env.TELEGRAM_PRIVATE_CHANNEL_ID;
  if (!bot || !channelId) return false;

  try {
    await bot.banChatMember(channelId, telegramUserId);
    // Immediately unban so they can rejoin later if they resubscribe
    await bot.unbanChatMember(channelId, telegramUserId, { only_if_banned: true });

    await bot.sendMessage(telegramUserId,
      "Your subscription has ended. You've been removed from the premium channel.\n" +
      "Use /subscribe to renew."
    ).catch(() => {}); // DM might fail if they blocked the bot

    return true;
  } catch (err) {
    console.error("[telegram-access] Error revoking access:", err.message);
    return false;
  }
}

/**
 * Sweep: verify all channel members have active paid subscriptions.
 * Call this daily or on a schedule.
 */
export async function sweepChannelMembers() {
  const bot = getTelegramBot();
  const channelId = process.env.TELEGRAM_PRIVATE_CHANNEL_ID;
  if (!bot || !channelId) return { checked: 0, revoked: 0 };

  // Get all paid subscribers with Telegram linked
  const paidSubs = listPaidSubscribers().filter((s) => s.telegram_user_id);
  const paidTelegramIds = new Set(paidSubs.map((s) => s.telegram_user_id));

  // We can't enumerate channel members via bot API easily,
  // but we can verify known subscribers are still paid
  let revoked = 0;
  for (const sub of paidSubs) {
    if (!isPaid(sub)) {
      await revokeChannelAccess(sub.telegram_user_id);
      revoked++;
    }
  }

  return { checked: paidSubs.length, revoked };
}
