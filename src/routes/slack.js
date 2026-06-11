// Phase 9 — /api/slack routes.
//
//   GET  /api/slack/connection        connection + config state (session auth)
//   GET  /api/slack/oauth/start        begin "Add to Slack" (session auth, redirect)
//   GET  /api/slack/oauth/callback     finish install (state-protected)
//   POST /api/slack/oauth/disconnect   remove installs for the user (session + CSRF)
//   POST /api/slack/commands           slash command (Slack-signed, no session)
//   POST /api/slack/interactions       button clicks (Slack-signed, no session)
//
// The slash command + interactions endpoints are authenticated by Slack's
// request signature (HMAC + timestamp replay window), NOT by a Nivaria
// session. We resolve the incoming Slack (team_id, user_id) to a Nivaria
// account via the slack_installations table written during OAuth install.

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { getDb } = require('../db');
const { csrfProtect } = require('../middleware/security');
const slackOAuth = require('../slackOAuth');
const tokens = require('../calendarTokens'); // generic AES vault, reused for bot tokens
const {
  parseSlackCommand, findCompetitorMatch, verifySlackSignature,
  usageMessage, notLinkedMessage, confirmationMessage, competitorPickerMessage,
} = require('../slackCommands');
const { createDeal, DealError } = require('../deals');
const { PATTERN_TYPES } = require('../correlationEngine');

const APP_URL = () => process.env.APP_URL || 'http://localhost:3000';

// Body parser dedicated to the Slack-signed endpoints. Captures the raw body so
// the HMAC can be verified against the exact bytes Slack signed.
const slackBody = express.urlencoded({
  extended: false,
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
});

function requireAuthSession(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  req.userId = req.session.userId;
  next();
}

function verifyOr401(req, res) {
  const v = verifySlackSignature({
    signingSecret: slackOAuth.config().signingSecret,
    timestamp: req.headers['x-slack-request-timestamp'],
    signature: req.headers['x-slack-signature'],
    rawBody: req.rawBody,
  });
  if (!v.ok) {
    console.warn(`[slack] signature rejected: ${v.reason}`);
    res.status(401).send('Slack signature verification failed');
    return false;
  }
  return true;
}

function resolveUser(db, teamId, slackUserId) {
  if (!teamId || !slackUserId) return null;
  const row = db.prepare(
    "SELECT user_id FROM slack_installations WHERE slack_team_id = ? AND slack_user_id = ? AND status = 'active'"
  ).get(teamId, slackUserId);
  return row ? row.user_id : null;
}

// ── Connection state (for Settings UI) ───────────────────────────────────────

router.get('/connection', requireAuthSession, (req, res) => {
  const db = getDb();
  const install = db.prepare(
    "SELECT slack_team_name, slack_user_id, installed_at FROM slack_installations WHERE user_id = ? AND status = 'active' ORDER BY installed_at DESC LIMIT 1"
  ).get(req.userId);
  res.json({
    oauth_configured: slackOAuth.isConfigured(),
    signing_configured: slackOAuth.signingConfigured(),
    connected: !!install,
    workspace: install?.slack_team_name || null,
  });
});

// ── OAuth: start ─────────────────────────────────────────────────────────────

router.get('/oauth/start', requireAuthSession, (req, res) => {
  if (!slackOAuth.isConfigured()) {
    return res.status(500).json({ error: 'Slack OAuth is not configured. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_REDIRECT_URI in .env.' });
  }
  const state = crypto.randomBytes(24).toString('hex');
  req.session.slackOAuthState = { state, userId: req.userId, issuedAt: Date.now() };
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.redirect(slackOAuth.getAuthUrl(state));
  });
});

// ── OAuth: callback ──────────────────────────────────────────────────────────

router.get('/oauth/callback', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login?returnTo=' + encodeURIComponent('/app#/settings/integrations'));
  }
  const userId = req.session.userId;

  if (req.query.error) {
    return res.redirect('/app#/settings/integrations?slack_error=' + encodeURIComponent(String(req.query.error).slice(0, 200)));
  }

  const expected = req.session.slackOAuthState;
  const incomingState = String(req.query.state || '');
  const incomingCode  = String(req.query.code || '');
  req.session.slackOAuthState = null; // single-use

  if (!expected || expected.userId !== userId) {
    return res.redirect('/app#/settings/integrations?slack_error=' + encodeURIComponent('OAuth state missing. Start again.'));
  }
  const a = Buffer.from(expected.state, 'utf8');
  const b = Buffer.from(incomingState, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.redirect('/app#/settings/integrations?slack_error=' + encodeURIComponent('OAuth state mismatch. Possible CSRF.'));
  }
  if (Date.now() - expected.issuedAt > 10 * 60 * 1000) {
    return res.redirect('/app#/settings/integrations?slack_error=' + encodeURIComponent('OAuth flow timed out. Start again.'));
  }
  if (!incomingCode) {
    return res.redirect('/app#/settings/integrations?slack_error=' + encodeURIComponent('No authorization code returned.'));
  }

  try {
    const inst = await slackOAuth.exchangeCode(incomingCode);
    if (!inst.teamId || !inst.slackUserId) throw new Error('Slack did not return team/user identity');

    // Encrypt the bot token at rest when the vault key is present; the slash
    // command flow itself doesn't need the bot token (it replies over HTTP),
    // so a missing key degrades gracefully to a null token.
    const botTokenEnc = (inst.botToken && tokens.isConfigured()) ? tokens.encrypt(inst.botToken) : null;

    const db = getDb();
    db.prepare(`
      INSERT INTO slack_installations
        (user_id, slack_team_id, slack_team_name, slack_user_id, bot_token_enc, bot_user_id, scope, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(slack_team_id, slack_user_id) DO UPDATE SET
        user_id        = excluded.user_id,
        slack_team_name = excluded.slack_team_name,
        bot_token_enc  = excluded.bot_token_enc,
        bot_user_id    = excluded.bot_user_id,
        scope          = excluded.scope,
        status         = 'active'
    `).run(userId, inst.teamId, inst.teamName, inst.slackUserId, botTokenEnc, inst.botUserId, inst.scope);

    res.redirect('/app#/settings/integrations?slack_connected=1');
  } catch (e) {
    console.error('[slack:callback] failed:', e.message);
    res.redirect('/app#/settings/integrations?slack_error=' + encodeURIComponent(e.message.slice(0, 200)));
  }
});

// ── OAuth: disconnect ────────────────────────────────────────────────────────

router.post('/oauth/disconnect', requireAuthSession, csrfProtect, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE slack_installations SET status = 'revoked', bot_token_enc = NULL WHERE user_id = ?").run(req.userId);
  res.json({ success: true });
});

// ── Slash command ────────────────────────────────────────────────────────────

router.post('/commands', slackBody, (req, res) => {
  if (!verifyOr401(req, res)) return;

  const db = getDb();
  const body = req.body || {};
  const parsed = parseSlackCommand(body.text || '');

  if (!parsed.ok) {
    return res.json(usageMessage());
  }

  const userId = resolveUser(db, body.team_id, body.user_id);
  if (!userId) {
    return res.json(notLinkedMessage(APP_URL()));
  }

  const competitors = db.prepare('SELECT id, name FROM competitors WHERE user_id = ?').all(userId);

  // Resolve competitor: required for lost/stalled, optional for won.
  let competitorId = null;
  let competitorName = null;
  if (parsed.outcome === 'lost' || parsed.outcome === 'stalled') {
    const match = findCompetitorMatch(competitors, parsed.competitor_name);
    if (!match) {
      return res.json(competitorPickerMessage({ pending: parsed, competitors, appUrl: APP_URL() }));
    }
    competitorId = match.id;
    competitorName = match.name;
  } else if (parsed.competitor_name) {
    const match = findCompetitorMatch(competitors, parsed.competitor_name);
    if (match) { competitorId = match.id; competitorName = match.name; }
  }

  try {
    createDeal(userId, {
      deal_name: parsed.deal_name,
      outcome: parsed.outcome,
      competitor_id: competitorId,
      deal_value_usd: parsed.value_usd,
      source: 'slack_command',
    });
    res.json(confirmationMessage({
      outcome: parsed.outcome,
      deal_name: parsed.deal_name,
      value_usd: parsed.value_usd,
      competitor_name: competitorName,
      appUrl: APP_URL(),
    }));
  } catch (e) {
    const msg = e instanceof DealError ? e.message : 'Could not log the deal.';
    res.json({ response_type: 'ephemeral', text: `:warning: ${msg}` });
  }
});

// ── Interactions (competitor picker button) ──────────────────────────────────

router.post('/interactions', slackBody, (req, res) => {
  if (!verifyOr401(req, res)) return;

  let payload;
  try { payload = JSON.parse(req.body.payload || '{}'); }
  catch { return res.json({ text: 'Could not read interaction payload.' }); }

  if (payload.type !== 'block_actions' || !payload.actions?.length) {
    return res.json({});
  }

  const db = getDb();
  const userId = resolveUser(db, payload.team?.id, payload.user?.id);
  if (!userId) {
    return res.json({ replace_original: true, text: notLinkedMessage(APP_URL()).text });
  }

  let pending;
  try { pending = JSON.parse(payload.actions[0].value || '{}'); }
  catch { return res.json({ replace_original: true, text: 'Could not read the selected competitor.' }); }

  // Validate the chosen competitor belongs to this user.
  const comp = db.prepare('SELECT id, name FROM competitors WHERE id = ? AND user_id = ?').get(pending.competitor_id, userId);
  if (!comp) {
    return res.json({ replace_original: true, text: ':warning: That competitor is no longer available.' });
  }

  try {
    createDeal(userId, {
      deal_name: pending.deal_name,
      outcome: pending.outcome,
      competitor_id: comp.id,
      deal_value_usd: pending.value_usd,
      source: 'slack_command',
    });
    res.json({
      replace_original: true,
      text: confirmationMessage({
        outcome: pending.outcome,
        deal_name: pending.deal_name,
        value_usd: pending.value_usd,
        competitor_name: comp.name,
        appUrl: APP_URL(),
      }).text,
    });
  } catch (e) {
    const msg = e instanceof DealError ? e.message : 'Could not log the deal.';
    res.json({ replace_original: true, text: `:warning: ${msg}` });
  }
});

module.exports = router;
