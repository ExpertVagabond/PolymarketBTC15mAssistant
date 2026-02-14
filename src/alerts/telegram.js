/**
 * Telegram Bot API alert sender.
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

export function isTelegramConfigured() {
  return BOT_TOKEN.length > 0 && CHAT_ID.length > 0;
}

export async function sendTelegramMessage(text) {
  if (!isTelegramConfigured()) return { ok: false, reason: "not_configured" };

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "Markdown"
      })
    });
    const data = await res.json();
    return { ok: data.ok, messageId: data.result?.message_id };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
