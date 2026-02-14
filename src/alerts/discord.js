/**
 * Discord webhook alert sender.
 * Env: DISCORD_WEBHOOK_URL
 */

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

export function isDiscordConfigured() {
  return WEBHOOK_URL.length > 0;
}

export async function sendDiscordMessage(text) {
  if (!isDiscordConfigured()) return { ok: false, reason: "not_configured" };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text })
    });
    return { ok: res.status === 204 || res.ok };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
