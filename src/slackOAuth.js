// Phase 9 — Slack "Add to Slack" OAuth v2 install flow.
//
// A logged-in Nivaria user clicks "Add to Slack" in Settings. We redirect to
// Slack's authorize screen requesting the `commands` bot scope. On callback we
// exchange the code for a bot token and capture the installing Slack user id
// (authed_user.id) so future slash commands resolve back to this Nivaria
// account. Bot tokens are encrypted at rest by src/calendarTokens.js (the same
// generic AES-256-GCM vault used for calendar tokens).
//
// Gracefully degrades: when SLACK_CLIENT_ID/SECRET/REDIRECT_URI aren't set, the
// flow reports not-configured (the Settings card shows a disabled state and the
// README explains setup), exactly like the calendar OAuth guard.

const axios = require('axios');

const BOT_SCOPES = ['commands'];
const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const ACCESS_URL    = 'https://slack.com/api/oauth.v2.access';

function config() {
  return {
    clientId:     process.env.SLACK_CLIENT_ID || '',
    clientSecret: process.env.SLACK_CLIENT_SECRET || '',
    redirectUri:  process.env.SLACK_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:3000'}/api/slack/oauth/callback`,
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
  };
}

// OAuth install requires client id/secret/redirect. The signing secret is
// checked separately by the command endpoint.
function isConfigured() {
  const c = config();
  return !!(c.clientId && c.clientSecret && c.redirectUri);
}

function signingConfigured() {
  return !!config().signingSecret;
}

function getAuthUrl(state) {
  const c = config();
  if (!isConfigured()) throw new Error('Slack OAuth env vars missing. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_REDIRECT_URI in .env.');
  const params = new URLSearchParams({
    client_id: c.clientId,
    scope: BOT_SCOPES.join(','),
    redirect_uri: c.redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// Exchange the authorization code. Returns the normalized install record.
async function exchangeCode(code) {
  const c = config();
  const r = await axios.post(ACCESS_URL, new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    redirect_uri: c.redirectUri,
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });

  const data = r.data || {};
  if (!data.ok) {
    const err = new Error(`Slack token exchange failed: ${data.error || 'unknown_error'}`);
    err.slackError = data.error;
    throw err;
  }

  return {
    ok: true,
    botToken:   data.access_token || null,
    botUserId:  data.bot_user_id || null,
    scope:      data.scope || null,
    teamId:     data.team?.id || null,
    teamName:   data.team?.name || null,
    slackUserId: data.authed_user?.id || null,
  };
}

module.exports = { isConfigured, signingConfigured, getAuthUrl, exchangeCode, config, BOT_SCOPES };
