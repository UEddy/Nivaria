// A user's Slack and Discord incoming webhooks: where they are kept, and what
// counts as a valid one.
//
// They live on the user's settings row (the Profile, Integrations card), except
// on the shared demo account: every judge signs in as the same user, so there
// they are kept in the browser session instead, and one judge never sees,
// overwrites or posts to another judge's channel.
//
// Only Slack and Discord hosts are accepted, so the server never posts to an
// arbitrary URL someone pastes in.

const { getDb } = require('../db');
const { isDemoEmail } = require('./demoAccount');

function isValidSlackWebhook(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' &&
      (u.hostname === 'hooks.slack.com' || u.hostname.endsWith('.slack.com'));
  } catch { return false; }
}

function isValidDiscordWebhook(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' &&
      (u.hostname === 'discord.com' || u.hostname === 'discordapp.com' ||
       u.hostname.endsWith('.discord.com'));
  } catch { return false; }
}

// 'slack', 'discord', or null for anything else.
function webhookKind(url) {
  if (isValidSlackWebhook(url)) return 'slack';
  if (isValidDiscordWebhook(url)) return 'discord';
  return null;
}

const keptInSession = req => isDemoEmail(req.user?.email);

function getWebhooks(req) {
  if (keptInSession(req)) {
    const s = req.session?.demoWebhooks || {};
    return { slack_webhook: s.slack_webhook || null, discord_webhook: s.discord_webhook || null };
  }
  const row = getDb().prepare('SELECT slack_webhook, discord_webhook FROM settings WHERE user_id = ?').get(req.userId) || {};
  return { slack_webhook: row.slack_webhook || null, discord_webhook: row.discord_webhook || null };
}

// changes: { slack_webhook?, discord_webhook? }. An absent key keeps its value;
// null or '' clears it. Validate before calling.
function saveWebhooks(req, changes) {
  const next = { ...getWebhooks(req) };
  for (const k of ['slack_webhook', 'discord_webhook']) {
    if (changes[k] !== undefined) next[k] = changes[k] || null;
  }
  if (keptInSession(req)) {
    req.session.demoWebhooks = next;
    return next;
  }
  getDb().prepare(`
    INSERT INTO settings (user_id, slack_webhook, discord_webhook) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET slack_webhook = excluded.slack_webhook, discord_webhook = excluded.discord_webhook
  `).run(req.userId, next.slack_webhook, next.discord_webhook);
  return next;
}

module.exports = { isValidSlackWebhook, isValidDiscordWebhook, webhookKind, keptInSession, getWebhooks, saveWebhooks };
