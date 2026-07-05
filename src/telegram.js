const axios = require('axios');

// Internal, admin-only notifications sent to the founder's private Telegram chat
// via the Telegram Bot API. This is NOT a customer feature and is unrelated to
// the Slack/Discord competitor-alert webhooks in webhooks.js (those go to
// customers). It is a private heads-up so the founder learns about signups
// without checking /admin/stats.
//
// Configuration is entirely through environment variables (set these in Railway):
//   TELEGRAM_BOT_TOKEN     the bot token from BotFather
//   TELEGRAM_ADMIN_CHAT_ID the founder's private chat id the bot messages
//
// If either is absent the module is a clean no-op, so dev and any environment
// without the vars set behaves normally and never errors.

// Low-level send. Resolves to true on success, false on any failure. Never
// throws: a Telegram outage or misconfiguration must never surface to a caller
// in the signup flow. Callers should still treat this as fire-and-forget.
async function sendAdminMessage(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  // Gate: no-op unless both are configured. Not an error.
  if (!token || !chatId) return false;

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, disable_web_page_preview: true },
      { timeout: 10000 }
    );
    return true;
  } catch (err) {
    // Structured tag, no crash. Telegram's own error text (if any) is the most
    // useful part; fall back to the transport message.
    const detail = err.response?.data?.description || err.message;
    console.error(`[telegram] admin notification failed: ${detail}`);
    return false;
  }
}

// New-signup alert. `email` is the new account's email (this goes only to the
// admin's private chat, so a minimal identifier is fine). `totalUsers` is the
// authoritative user count at this moment, computed by the caller from the same
// source /admin/stats uses. Fire-and-forget: do not await this in a way that
// blocks the signup response.
async function notifyNewSignup(email, totalUsers) {
  const who = email || 'new user';
  return sendAdminMessage(`New Nivaria signup: ${who}. Total users: ${totalUsers}.`);
}

module.exports = { sendAdminMessage, notifyNewSignup };
