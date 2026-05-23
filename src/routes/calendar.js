// Phase 7 — calendar OAuth + meeting management routes.
//
// /api/calendar/connections                         GET   list active connections (no tokens returned)
// /api/calendar/google/connect                      GET   initiate Google OAuth (redirects)
// /api/calendar/google/callback                     GET   handle redirect from Google
// /api/calendar/google/disconnect                   POST  revoke + delete connection
// /api/calendar/microsoft/connect                   GET   501 (stub)
// /api/calendar/microsoft/callback                  GET   501 (stub)
// /api/calendar/microsoft/disconnect                POST  501 (stub)
// /api/calendar/meetings/upcoming                   GET   tracked meetings in the next 14 days
// /api/calendar/meetings/:id/tag                    PUT   manual tag with a competitor
// /api/calendar/meetings/by-competitor/:competitorId GET  upcoming meetings for one competitor
// /api/calendar/sync-now                            POST  trigger sync inline (debugging / Test 2,3,6)
//
// Auth model:
//   /connections, /disconnect, /meetings/*, /sync-now → require session auth + CSRF
//   /google/connect → require session auth (state param protects callback CSRF)
//   /google/callback → no body parse; verifies state against session and runs
//                       a one-shot rate limit. Tokens never leave the server.

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { getDb }          = require('../db');
const { encrypt, decrypt, isConfigured: tokensConfigured } = require('../calendarTokens');
const { providerFor }    = require('../calendarOAuth');
const { csrfProtect }    = require('../middleware/security');
const { syncOneConnection } = require('../calendarSync');
const rateLimit = require('express-rate-limit');

// Diagnostic logging for the OAuth flow. Off by default; flip OAUTH_DEBUG=1
// in .env when you need to trace a misbehaving connect/callback. Tokens are
// already redacted in the call sites, but silencing them in production keeps
// the log volume down.
const oauthDebug = (msg) => { if (process.env.OAUTH_DEBUG) console.log(msg); };

// Dedicated limiter for the OAuth callback — discourages anyone trying to
// brute-force state values.
const callbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).send('Too many OAuth callbacks. Try again in 15 minutes.'),
});

function requireAuthSession(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  req.userId = req.session.userId;
  next();
}

// ── Connections (sanitized — never returns tokens) ──────────────────────────

router.get('/connections', requireAuthSession, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, provider, account_email, status, scope, last_synced_at, last_sync_error, created_at
    FROM calendar_connections WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.userId);
  res.json({
    encryption_configured: tokensConfigured(),
    connections: rows,
  });
});

// ── Google OAuth — initiate ─────────────────────────────────────────────────
// Generates a random state, stores it in the session, redirects to Google.
// CSRF is protected by the state round-trip; we do not require X-CSRF-Token
// because this is a navigational GET.

router.get('/google/connect', requireAuthSession, (req, res) => {
  if (!tokensConfigured()) {
    return res.status(500).json({
      error: 'CALENDAR_TOKEN_ENCRYPTION_KEY is not configured. Add it to .env before connecting a calendar.',
    });
  }
  try {
    const state = crypto.randomBytes(24).toString('hex');
    req.session.calendarOAuthState = {
      provider: 'google',
      state,
      userId: req.userId,
      issuedAt: Date.now(),
    };
    oauthDebug(`[calendar:connect] before save sid=${String(req.sessionID).slice(0,8)}… userId=${req.userId} state8=${state.slice(0,8)} cookieHeader=${req.headers.cookie ? 'present' : 'absent'}`);
    req.session.save((err) => {
      if (err) {
        console.error(`[calendar:connect] session.save FAILED: ${err.message}`);
        return res.status(500).json({ error: 'Session error' });
      }
      oauthDebug(`[calendar:connect] session.save ok — redirecting to Google with state8=${state.slice(0,8)}`);
      const { providerFor } = require('../calendarOAuth');
      const url = providerFor('google').getAuthUrl(state);
      res.redirect(url);
    });
  } catch (e) {
    console.error('Google OAuth init failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Google OAuth — callback ─────────────────────────────────────────────────

router.get('/google/callback', callbackLimiter, async (req, res) => {
  // No CSRF middleware here on purpose — we use the state param + session.
  const sessKeys = req.session ? Object.keys(req.session).filter(k => k !== 'cookie') : [];
  oauthDebug(`[calendar:callback] ENTRY cookieHeader=${req.headers.cookie ? 'present' : 'ABSENT'} sid=${String(req.sessionID || '').slice(0,8)}… sessionKeys=[${sessKeys.join(',')}] userId=${req.session?.userId ?? 'undef'} hasState=${!!req.session?.calendarOAuthState} query.state8=${String(req.query.state || '').slice(0,8)} query.codeLen=${String(req.query.code || '').length} query.error=${req.query.error || 'none'}`);

  if (!req.session?.userId) {
    oauthDebug(`[calendar:callback] REJECT reason=no_session_userId → redirect /login`);
    return res.redirect('/login?returnTo=' + encodeURIComponent('/app#/settings'));
  }
  const userId = req.session.userId;

  // Surface OAuth errors back to the user instead of leaving them stranded.
  if (req.query.error) {
    oauthDebug(`[calendar:callback] REJECT reason=google_returned_error error=${req.query.error}`);
    const msg = encodeURIComponent(String(req.query.error_description || req.query.error).slice(0, 200));
    return res.redirect(`/app#/settings?calendar_error=${msg}`);
  }

  const expected = req.session.calendarOAuthState;
  const incomingState = String(req.query.state || '');
  const incomingCode  = String(req.query.code  || '');

  oauthDebug(`[calendar:callback] state-check expected.provider=${expected?.provider} expected.userId=${expected?.userId} expected.state8=${(expected?.state || '').slice(0,8)} incoming.state8=${incomingState.slice(0,8)} match=${expected?.state === incomingState}`);

  // Wipe the state slot before any failure path so a single failed callback
  // can't be replayed.
  req.session.calendarOAuthState = null;

  if (!expected || expected.provider !== 'google' || expected.userId !== userId) {
    oauthDebug(`[calendar:callback] REJECT reason=state_missing_or_mismatched expected=${!!expected} provider=${expected?.provider} expectedUser=${expected?.userId} sessionUser=${userId}`);
    return res.redirect('/app#/settings?calendar_error=' + encodeURIComponent('OAuth state missing or mismatched. Start the flow again.'));
  }
  // Constant-time comparison — state is hex so lengths are predictable.
  const a = Buffer.from(expected.state, 'utf8');
  const b = Buffer.from(incomingState, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    oauthDebug(`[calendar:callback] REJECT reason=state_bytes_mismatch expectedLen=${a.length} incomingLen=${b.length}`);
    return res.redirect('/app#/settings?calendar_error=' + encodeURIComponent('OAuth state mismatch. Possible CSRF — start the flow again.'));
  }
  if (Date.now() - expected.issuedAt > 10 * 60 * 1000) {
    oauthDebug(`[calendar:callback] REJECT reason=state_expired ageMs=${Date.now() - expected.issuedAt}`);
    return res.redirect('/app#/settings?calendar_error=' + encodeURIComponent('OAuth flow timed out. Start the flow again.'));
  }
  if (!incomingCode) {
    oauthDebug(`[calendar:callback] REJECT reason=no_auth_code`);
    return res.redirect('/app#/settings?calendar_error=' + encodeURIComponent('No authorization code returned.'));
  }

  try {
    oauthDebug(`[calendar:callback] state ok → exchanging code (len=${incomingCode.length}) for tokens`);
    const provider = providerFor('google');
    const tokens   = await provider.exchangeCode(incomingCode);
    oauthDebug(`[calendar:callback] token exchange ok accessLen=${(tokens.access||'').length} refreshLen=${(tokens.refresh||'').length} expiresAt=${tokens.expiresAt || 'null'} scope=${(tokens.scope||'').length}chars`);
    if (!tokens.access) throw new Error('Provider returned no access token');

    const email = await provider.getUserEmail(tokens.access);
    oauthDebug(`[calendar:callback] userinfo email=${email ? email.slice(0,3)+'***@'+(email.split('@')[1]||'?') : 'null'}`);

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO calendar_connections
        (user_id, provider, account_email, access_token_enc, refresh_token_enc, expires_at, scope, status)
      VALUES (?, 'google', ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(user_id, provider) DO UPDATE SET
        account_email     = excluded.account_email,
        access_token_enc  = excluded.access_token_enc,
        refresh_token_enc = COALESCE(excluded.refresh_token_enc, calendar_connections.refresh_token_enc),
        expires_at        = excluded.expires_at,
        scope             = excluded.scope,
        status            = 'active',
        last_sync_error   = NULL
    `).run(
      userId,
      email || null,
      encrypt(tokens.access),
      tokens.refresh ? encrypt(tokens.refresh) : null,
      tokens.expiresAt,
      tokens.scope,
    );
    oauthDebug(`[calendar:callback] DB upsert ok lastInsertRowid=${result.lastInsertRowid} for userId=${userId}`);

    // Best-effort initial sync so the user sees populated meetings immediately
    // instead of waiting up to 15 minutes for the cron tick.
    try {
      const syncSummary = await syncOneConnection({ userId, provider: 'google' });
      oauthDebug(`[calendar:callback] initial sync ok: ${JSON.stringify(syncSummary)}`);
    } catch (syncErr) {
      console.warn(`[calendar:callback] initial sync FAILED (non-fatal): ${syncErr.message}`);
    }

    oauthDebug(`[calendar:callback] SUCCESS → redirecting to /app#/settings?calendar_connected=google`);
    res.redirect('/app#/settings?calendar_connected=google');
  } catch (e) {
    console.error(`[calendar:callback] EXCEPTION in token/insert path: ${e.message}\n${e.stack?.split('\n').slice(0,4).join('\n')}`);
    res.redirect('/app#/settings?calendar_error=' + encodeURIComponent(e.message.slice(0, 200)));
  }
});

// ── Google OAuth — disconnect ───────────────────────────────────────────────

router.post('/google/disconnect', requireAuthSession, csrfProtect, async (req, res) => {
  const db = getDb();
  const row = db.prepare(
    "SELECT id, access_token_enc FROM calendar_connections WHERE user_id = ? AND provider = 'google'"
  ).get(req.userId);
  if (!row) return res.json({ success: true });

  try {
    if (row.access_token_enc) {
      const access = decrypt(row.access_token_enc);
      if (access) await providerFor('google').revokeAccessToken(access);
    }
  } catch (_) { /* revoke is best-effort */ }

  db.prepare('DELETE FROM calendar_connections WHERE id = ? AND user_id = ?').run(row.id, req.userId);
  // Drop cached meetings tied to this connection. Cascade-on-delete isn't
  // active in sql.js, so we do it explicitly.
  db.prepare("DELETE FROM tracked_meetings WHERE user_id = ? AND provider = 'google'").run(req.userId);

  res.json({ success: true });
});

// ── Microsoft (stubbed) ─────────────────────────────────────────────────────

router.get('/microsoft/connect',    requireAuthSession, (_req, res) => res.status(501).json({ error: 'Microsoft 365 Calendar — coming soon.' }));
router.get('/microsoft/callback',                          (_req, res) => res.status(501).send('Microsoft 365 Calendar — coming soon.'));
router.post('/microsoft/disconnect', requireAuthSession, csrfProtect, (_req, res) => res.status(501).json({ error: 'Microsoft 365 Calendar — coming soon.' }));

// ── Meetings ────────────────────────────────────────────────────────────────

router.get('/meetings/upcoming', requireAuthSession, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id, m.title, m.start_time, m.end_time, m.match_reason, m.briefing_status,
           m.briefing_sent_at, m.matched_competitor_id, m.provider,
           c.name AS competitor_name
    FROM tracked_meetings m
    LEFT JOIN competitors c ON m.matched_competitor_id = c.id
    WHERE m.user_id = ?
      AND m.start_time >= datetime('now')
      AND m.start_time <= datetime('now', '+14 days')
    ORDER BY m.start_time ASC
    LIMIT 50
  `).all(req.userId);
  res.json({ meetings: rows });
});

router.get('/meetings/by-competitor/:competitorId', requireAuthSession, (req, res) => {
  const db = getDb();
  const competitorId = parseInt(req.params.competitorId, 10);
  if (!Number.isInteger(competitorId)) return res.status(400).json({ error: 'invalid id' });

  const own = db.prepare('SELECT id FROM competitors WHERE id = ? AND user_id = ?').get(competitorId, req.userId);
  if (!own) return res.status(404).json({ error: 'Not found' });

  const rows = db.prepare(`
    SELECT id, title, start_time, end_time, match_reason, briefing_status, briefing_sent_at, provider
    FROM tracked_meetings
    WHERE user_id = ?
      AND matched_competitor_id = ?
      AND start_time >= datetime('now')
      AND start_time <= datetime('now', '+14 days')
    ORDER BY start_time ASC
  `).all(req.userId, competitorId);
  res.json({ competitor_id: competitorId, meetings: rows });
});

router.put('/meetings/:id/tag', requireAuthSession, csrfProtect, (req, res) => {
  const db = getDb();
  const meetingId = parseInt(req.params.id, 10);
  if (!Number.isInteger(meetingId)) return res.status(400).json({ error: 'invalid id' });

  const meeting = db.prepare('SELECT id, user_id FROM tracked_meetings WHERE id = ? AND user_id = ?')
    .get(meetingId, req.userId);
  if (!meeting) return res.status(404).json({ error: 'Not found' });

  const competitorIdRaw = req.body?.competitor_id;
  // Allow `null` to clear the tag back to unmatched.
  if (competitorIdRaw === null) {
    db.prepare(`UPDATE tracked_meetings SET matched_competitor_id = NULL, match_reason = 'none' WHERE id = ?`).run(meetingId);
    return res.json({ success: true, matched_competitor_id: null, match_reason: 'none' });
  }

  const competitorId = parseInt(competitorIdRaw, 10);
  if (!Number.isInteger(competitorId)) return res.status(400).json({ error: 'competitor_id required (integer) or null to clear' });

  const own = db.prepare('SELECT id FROM competitors WHERE id = ? AND user_id = ?').get(competitorId, req.userId);
  if (!own) return res.status(400).json({ error: 'Competitor not found or not yours' });

  db.prepare(`
    UPDATE tracked_meetings
    SET matched_competitor_id = ?, match_reason = 'manual', briefing_status = 'pending', briefing_error = NULL
    WHERE id = ?
  `).run(competitorId, meetingId);
  res.json({ success: true, matched_competitor_id: competitorId, match_reason: 'manual' });
});

// Debug / test helper — triggers a sync for the caller's google connection
// without waiting for the cron tick. Useful for Tests 2, 3, 6.
router.post('/sync-now', requireAuthSession, csrfProtect, async (req, res) => {
  try {
    const result = await syncOneConnection({ userId: req.userId, provider: 'google' });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
