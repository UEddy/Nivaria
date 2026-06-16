const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { getDb }         = require('../db');
const { canWorkspaceAccess, upgradeRequired } = require('../lib/tierLimits');
const { logAudit }      = require('../lib/audit');

// ── Validation helpers ─────────────────────────────────────────────────────────

function isValidHttpsUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'https:';
  } catch { return false; }
}

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

function isValidEmail(str) {
  return typeof str === 'string' && str.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const db       = getDb();
  const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(req.userId);
  const user     = db.prepare('SELECT id, email, name, first_name, timezone, tier, api_key, created_at FROM users WHERE id = ?').get(req.userId);
  res.json({ settings: settings || {}, user });
});

router.put('/', (req, res) => {
  const db = getDb();
  const { slack_webhook, discord_webhook, notification_email,
          briefings_enabled, briefing_lead_minutes, brief_email_enabled } = req.body;

  // Validate webhook URLs if provided
  if (slack_webhook && !isValidSlackWebhook(slack_webhook)) {
    return res.status(400).json({ error: 'Invalid Slack webhook URL. Must be a valid https://hooks.slack.com URL.' });
  }
  if (discord_webhook && !isValidDiscordWebhook(discord_webhook)) {
    return res.status(400).json({ error: 'Invalid Discord webhook URL. Must be a valid https://discord.com/api/webhooks URL.' });
  }
  if (notification_email && !isValidEmail(notification_email)) {
    return res.status(400).json({ error: 'Invalid notification email address.' });
  }

  // Phase 7 briefing prefs — only validated when supplied (partial-update friendly)
  if (briefing_lead_minutes !== undefined && briefing_lead_minutes !== null) {
    const n = parseInt(briefing_lead_minutes, 10);
    if (![15, 30, 60].includes(n)) {
      return res.status(400).json({ error: 'briefing_lead_minutes must be 15, 30, or 60' });
    }
  }

  // Enforce length limits
  if (slack_webhook    && slack_webhook.length    > 500) return res.status(400).json({ error: 'Slack webhook URL too long' });
  if (discord_webhook  && discord_webhook.length  > 500) return res.status(400).json({ error: 'Discord webhook URL too long' });
  if (notification_email && notification_email.length > 254) return res.status(400).json({ error: 'Email address too long' });

  // Phase 10: webhook notifications are gated by the workspace's effective tier.
  if ((slack_webhook || discord_webhook) && !canWorkspaceAccess(req.workspaceId, 'webhooks')) {
    logAudit({ workspaceId: req.workspaceId, userId: req.userId, eventType: 'gate_violation', eventData: { feature: 'webhooks' }, req });
    return upgradeRequired(res, 'webhooks');
  }

  // Resolve every column against the existing row so a PARTIAL update never
  // nulls a field the caller didn't touch. A key is only written when present
  // in the body (an explicit null/'' still clears it); an absent key keeps the
  // stored value. This lets the Integrations panel save webhooks and the
  // Notifications panel save briefing prefs independently without clobbering
  // each other — the previous "write every column from the body" behavior would
  // null whichever group the current panel omitted. The legacy combined form
  // sends all fields, so its behavior is unchanged.
  const existing = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(req.userId) || {};
  const finalSlack = slack_webhook === undefined
    ? (existing.slack_webhook ?? null)
    : (slack_webhook || null);
  const finalDiscord = discord_webhook === undefined
    ? (existing.discord_webhook ?? null)
    : (discord_webhook || null);
  const finalNotifEmail = notification_email === undefined
    ? (existing.notification_email ?? null)
    : (notification_email || null);
  const finalBriefingsEnabled = briefings_enabled === undefined
    ? (existing.briefings_enabled ?? 1)
    : (briefings_enabled ? 1 : 0);
  const finalBriefingLead = briefing_lead_minutes === undefined
    ? (existing.briefing_lead_minutes ?? 30)
    : parseInt(briefing_lead_minutes, 10);
  const finalBriefEmailEnabled = brief_email_enabled === undefined
    ? (existing.brief_email_enabled ?? 1)
    : (brief_email_enabled ? 1 : 0);

  db.prepare(`
    INSERT INTO settings (user_id, slack_webhook, discord_webhook, notification_email,
                          briefings_enabled, briefing_lead_minutes, brief_email_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      slack_webhook         = excluded.slack_webhook,
      discord_webhook       = excluded.discord_webhook,
      notification_email    = excluded.notification_email,
      briefings_enabled     = excluded.briefings_enabled,
      briefing_lead_minutes = excluded.briefing_lead_minutes,
      brief_email_enabled   = excluded.brief_email_enabled
  `).run(
    req.userId,
    finalSlack,
    finalDiscord,
    finalNotifEmail,
    finalBriefingsEnabled,
    finalBriefingLead,
    finalBriefEmailEnabled,
  );

  res.json({ success: true });
});

router.post('/test-webhook', async (req, res) => {
  const type = String(req.body.type || '');
  const url  = String(req.body.url  || '');

  if (!url)  return res.status(400).json({ error: 'URL is required' });
  if (!isValidHttpsUrl(url)) return res.status(400).json({ error: 'Webhook URL must be a valid https:// URL' });
  if (url.length > 500) return res.status(400).json({ error: 'Webhook URL too long' });

  if (type === 'slack' && !isValidSlackWebhook(url)) {
    return res.status(400).json({ error: 'Invalid Slack webhook URL' });
  }
  if (type === 'discord' && !isValidDiscordWebhook(url)) {
    return res.status(400).json({ error: 'Invalid Discord webhook URL' });
  }

  try {
    if (type === 'slack') {
      await axios.post(url, { text: '✅ *Nivaria* webhook test. Everything is connected!' }, { timeout: 8000 });
    } else if (type === 'discord') {
      await axios.post(url, { content: '✅ **Nivaria** webhook test. Everything is connected!' }, { timeout: 8000 });
    } else {
      return res.status(400).json({ error: 'Invalid type. Use "slack" or "discord"' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: `Webhook test failed: ${err.message}` });
  }
});

module.exports = router;
