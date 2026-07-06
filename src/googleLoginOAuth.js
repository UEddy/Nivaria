// "Sign in with Google" — identity/login OAuth 2.0 (authorization-code flow).
//
// This is IDENTITY login only, completely separate from the Google Calendar
// integration in src/calendarOAuth.js. It requests only the basic profile and
// email scopes needed to identify a user; it never requests Calendar or any
// other scope. The two flows may share the SAME Google Cloud project (and even
// the same OAuth client), but they use their own env vars and callback URLs.
//
// Env vars (set these in Railway / .env):
//   GOOGLE_OAUTH_CLIENT_ID     OAuth client id. Shared with the Calendar
//   GOOGLE_OAUTH_CLIENT_SECRET OAuth client secret. integration (same Google
//                              Cloud project / same OAuth client), so the
//                              credentials live under a single name and can
//                              never drift across a rotation.
//   GOOGLE_LOGIN_REDIRECT_URI  Login callback URL (exact match required by
//                              Google). Kept SEPARATE from the Calendar callback
//                              (GOOGLE_OAUTH_REDIRECT_URI) because the login
//                              endpoint (/api/auth/google/callback) is a
//                              different route. Defaults to
//                              `${APP_URL}/api/auth/google/callback`.
//
// isConfigured() is false unless the client id + secret are present, so the app
// (and the login page's Google button) degrades cleanly when Google login is
// not set up.

const { google } = require('googleapis');

// Only what login needs: the user's email (and its verified flag) plus basic
// profile (name). Explicitly NO calendar or other scopes.
const LOGIN_SCOPES = ['openid', 'email', 'profile'];

function redirectUri() {
  if (process.env.GOOGLE_LOGIN_REDIRECT_URI) return process.env.GOOGLE_LOGIN_REDIRECT_URI;
  const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/api/auth/google/callback`;
}

function isConfigured() {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function loginClient() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google login env vars missing. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env.'
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri());
}

// URL the user is redirected to. `state` is the CSRF-protecting random value
// round-tripped through the session (verified in the callback).
function getAuthUrl(state) {
  return loginClient().generateAuthUrl({
    // No offline access / refresh token: login is a one-shot identity check, we
    // never call Google APIs on the user's behalf afterward.
    access_type: 'online',
    scope: LOGIN_SCOPES,
    state,
    prompt: 'select_account',
    include_granted_scopes: false,
  });
}

// Exchange the authorization code and verify the returned id_token, returning
// the trusted identity claims. Verifying the id_token (signature + audience via
// the google-auth-library that googleapis bundles) means we trust these fields
// without a second userinfo round-trip.
//   → { sub, email, emailVerified, name, givenName } or throws.
async function exchangeCodeForProfile(code) {
  const client = loginClient();

  // TEMPORARY diagnostic: confirm the running process is reading the correct,
  // non-empty Google credentials. Logs ONLY the last 4 chars and a present/absent
  // flag, never the full secret. Remove once the credential issue is resolved.
  {
    const id  = process.env.GOOGLE_OAUTH_CLIENT_ID  || '';
    const sec = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
    const last4 = (v) => v ? v.slice(-4) : '(none)';
    console.log(`[auth:google:debug] client_id present=${!!id} last4=${last4(id)} | client_secret present=${!!sec} last4=${last4(sec)}`);
  }

  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error('Google did not return an identity token');

  const ticket = await client.verifyIdToken({
    idToken:  tokens.id_token,
    audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
  });
  const payload = ticket.getPayload() || {};

  return {
    sub:          payload.sub || null,
    email:        payload.email ? String(payload.email).toLowerCase().trim() : null,
    // Google marks whether it has verified ownership of this address. We only
    // auto-link/verify when this is true.
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name:         payload.name       || null,
    givenName:    payload.given_name || null,
  };
}

module.exports = { isConfigured, getAuthUrl, exchangeCodeForProfile, redirectUri, LOGIN_SCOPES };
