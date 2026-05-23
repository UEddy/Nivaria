// Phase 7 — calendar OAuth + event fetching, abstracted by provider.
//
// Each provider exposes the same shape:
//   getAuthUrl(state)                 -> URL the user is redirected to
//   exchangeCode(code)                -> { access, refresh, expiresAt, scope }
//   refreshAccessToken(refreshToken)  -> { access, expiresAt }
//   getUserEmail(accessToken)         -> string | null
//   listUpcomingEvents(accessToken, opts) -> [{ id, title, start, end, attendees }]
//   revokeAccessToken(accessToken)    -> void (best-effort)
//
// Google is fully implemented. Microsoft is a stub that throws on any call —
// the Settings UI exposes "Microsoft 365 — coming soon" disabled, and the
// route handler returns 501 if anyone hits the endpoint directly.

const { google } = require('googleapis');
const axios = require('axios');

// ── Google ───────────────────────────────────────────────────────────────────

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

function googleClient() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Google OAuth env vars missing. Set GOOGLE_OAUTH_CLIENT_ID, ' +
      'GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI in .env.'
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

const Google = {
  getAuthUrl(state) {
    return googleClient().generateAuthUrl({
      access_type: 'offline',           // ensures refresh_token is returned
      prompt: 'consent',                // forces refresh_token even on re-auth
      scope: GOOGLE_SCOPES,
      include_granted_scopes: true,
      state,
    });
  },

  async exchangeCode(code) {
    const client = googleClient();
    const { tokens } = await client.getToken(code);
    return {
      access:    tokens.access_token  || null,
      refresh:   tokens.refresh_token || null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scope:     tokens.scope || null,
    };
  },

  async refreshAccessToken(refreshToken) {
    const client = googleClient();
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();
    return {
      access:    credentials.access_token || null,
      expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
    };
  },

  async getUserEmail(accessToken) {
    try {
      const r = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000,
      });
      return r.data?.email || null;
    } catch (_) {
      return null;
    }
  },

  // Returns events starting between `now` and `now + hoursAhead`. Recurring
  // event instances are expanded by singleEvents=true.
  async listUpcomingEvents(accessToken, { hoursAhead = 72 } = {}) {
    const client = googleClient();
    client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: client });
    const now = new Date();
    const max = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    const r = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: max.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const items = r.data.items || [];
    return items
      .filter(ev => ev.status !== 'cancelled' && (ev.start?.dateTime || ev.start?.date))
      .map(ev => ({
        id:    ev.id,
        title: ev.summary || '(untitled)',
        start: ev.start.dateTime || ev.start.date,
        end:   ev.end?.dateTime || ev.end?.date || null,
        attendees: (ev.attendees || [])
          .filter(a => a.email && !a.resource && !a.self)
          .map(a => ({
            email: String(a.email).toLowerCase(),
            name:  a.displayName || null,
            responseStatus: a.responseStatus || null,
          })),
      }));
  },

  async revokeAccessToken(accessToken) {
    try {
      await axios.post(
        'https://oauth2.googleapis.com/revoke',
        new URLSearchParams({ token: accessToken }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
      );
    } catch (_) {
      // Revoke is best-effort — Google's endpoint returns 200 once already
      // revoked but also can 400 for expired tokens. Either way we proceed
      // with local deletion.
    }
  },
};

// ── Microsoft (stub) ─────────────────────────────────────────────────────────

function microsoftNotImplemented() {
  const err = new Error('Microsoft 365 Calendar integration is not yet available.');
  err.code = 'PROVIDER_NOT_IMPLEMENTED';
  err.status = 501;
  throw err;
}

const Microsoft = {
  getAuthUrl:          microsoftNotImplemented,
  exchangeCode:        microsoftNotImplemented,
  refreshAccessToken:  microsoftNotImplemented,
  getUserEmail:        microsoftNotImplemented,
  listUpcomingEvents:  microsoftNotImplemented,
  revokeAccessToken:   microsoftNotImplemented,
};

function providerFor(name) {
  if (name === 'google')    return Google;
  if (name === 'microsoft') return Microsoft;
  throw new Error(`Unknown calendar provider: ${name}`);
}

module.exports = { providerFor, Google, Microsoft, GOOGLE_SCOPES };
