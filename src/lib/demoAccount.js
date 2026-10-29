// The shared demo login for hackathon judges.
//
// DEMO_LOGIN_EMAIL and DEMO_LOGIN_PASSWORD (set on the server, never in the
// repo) describe one account that ensureDemoAccount() creates at boot, or
// updates when the password changes. It is created verified, so signing in
// is the normal email and password login with no OTP email. Everyone who
// signs in with it shares it, so nobody can delete it, reset its password or
// rename it (see isDemoEmail in routes/account.js and routes/auth.js).
//
// Unset DEMO_LOGIN_EMAIL to turn the demo login off: the account then stays
// in the database but is no longer protected, and its password still works.

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { createPersonalWorkspace } = require('./workspace');

const MIN_PASSWORD = 12;
const DISPLAY_NAME = 'Judge';
// Matches routes/auth.js consentPolicyVersions(): the operator sets the
// account up, and signing in shows the same policies as any signup.
const CONSENT_VERSIONS = JSON.stringify({ policies: ['terms', 'privacy', 'cookies'], version: '2026-07-01' });

function demoEmail() {
  return String(process.env.DEMO_LOGIN_EMAIL || '').toLowerCase().trim();
}

function isDemoEmail(email) {
  const demo = demoEmail();
  return Boolean(demo) && String(email || '').toLowerCase().trim() === demo;
}

function ensureDemoAccount() {
  const email = demoEmail();
  if (!email) return;
  const password = String(process.env.DEMO_LOGIN_PASSWORD || '');
  if (password.length < MIN_PASSWORD) {
    console.warn('⚠️  DEMO_LOGIN_EMAIL is set but DEMO_LOGIN_PASSWORD is missing or under ' + MIN_PASSWORD + ' characters; demo login not set up');
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (existing) {
    if (!existing.password_hash || !bcrypt.compareSync(password, existing.password_hash)) {
      db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?')
        .run(bcrypt.hashSync(password, 12), existing.id);
    }
    db.prepare('UPDATE users SET email_verified = 1, deletion_requested_at = NULL, deletion_scheduled_at = NULL, deletion_cancel_token = NULL WHERE id = ?')
      .run(existing.id);
    createPersonalWorkspace(existing.id, DISPLAY_NAME, email);
    console.log('✅ Demo login ready for ' + email);
    return;
  }

  const r = db.prepare(
    'INSERT INTO users (email, name, first_name, timezone, tier, api_key, password_hash, email_verified, has_visited_dashboard, consent_given_at, consent_policy_versions) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP, ?)'
  ).run(email, DISPLAY_NAME, DISPLAY_NAME, 'UTC', 'free', 'cs-' + uuidv4().replace(/-/g, ''), bcrypt.hashSync(password, 12), CONSENT_VERSIONS);
  db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(r.lastInsertRowid);
  createPersonalWorkspace(r.lastInsertRowid, DISPLAY_NAME, email);
  console.log('✅ Demo login created for ' + email);
}

// The demo account's row, when the demo login is configured and the account
// exists (ensureDemoAccount ran at boot). Used by the one-click live demo.
function demoUser() {
  const email = demoEmail();
  if (!email) return null;
  return getDb().prepare('SELECT * FROM users WHERE email = ? AND email_verified = 1').get(email) || null;
}

module.exports = { ensureDemoAccount, isDemoEmail, demoUser };
