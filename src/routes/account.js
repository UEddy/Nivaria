// Phase 10 — GDPR data-rights endpoints.
//
//   GET  /api/account/export        → full JSON export of the user's data
//   POST /api/account/delete         → request deletion (30-day grace period)
//   POST /api/account/delete/cancel  → cancel a pending deletion (in-app)
//
// /delete and /delete/cancel require FRESH authentication (re-enter password):
// the CSRF token + session alone are not enough, so a hijacked session cannot
// trigger destruction. The email cancellation link uses a separate token-based
// public route (see restoreByToken, mounted in server.js).
//
// Secrets (calendar/slack OAuth tokens) are MASKED in the export. payment_events
// are NEVER deleted — they are anonymized (workspace_id → NULL) and retained for
// accounting/tax records.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const router = express.Router();

const { getDb } = require('../db');
const ls = require('../lemonSqueezy');
const { logAudit } = require('../lib/audit');
const limits = require('../middleware/rateLimits');

const GRACE_DAYS = 30;

function ownedWorkspaceIds(db, userId) {
  return db.prepare('SELECT id FROM workspaces WHERE owner_user_id = ?').all(userId).map(r => r.id);
}

// Fresh-auth: the request must include the account password.
function passwordOk(req) {
  const pw = req.body?.password;
  if (!pw || !req.user?.password_hash) return false;
  try { return bcrypt.compareSync(String(pw), req.user.password_hash); } catch { return false; }
}

// Privacy-preserving email hash for the retained audit record — the raw address
// is never logged. Same salted-SHA-256 construction as lib/audit.hashIp.
function hashEmail(email) {
  const salt = process.env.SESSION_SECRET || 'cs-audit-salt';
  return crypto.createHash('sha256').update(String(email) + salt).digest('hex');
}

// Validation for the friendly display name. Returns null when valid, else an
// error string. Allows letters (incl. accented), spaces, and the few name
// punctuation marks (. ' -); rejects digits and any character that could act as
// an XSS vector (< > & " / \ { } …). Output is still HTML-escaped at render time.
const NAME_RE = /^[\p{L}\p{M} .'\-]{1,50}$/u;
function validateFirstName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) return 'Name is required.';
  if (name.length > 50) return 'Name must be 50 characters or fewer.';
  if (!NAME_RE.test(name)) return 'Name can only contain letters, spaces, hyphens, apostrophes, and periods.';
  return null;
}

// Normalize a client-supplied IANA timezone. Verifies it against the host's
// timezone database via Intl; anything unknown/garbage falls back to 'UTC'.
function sanitizeTimezone(raw) {
  const tz = String(raw == null ? '' : raw).trim();
  if (!tz || tz.length > 64) return 'UTC';
  try {
    // Throws RangeError for an invalid zone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch { return 'UTC'; }
}

// Hard-delete one user and all data in the workspace(s) they own, atomically
// (savepoint suppresses mid-transaction export()). payment_events are RETAINED
// but anonymized (workspace_id → NULL) for accounting. Shared by the immediate
// account-deletion route and the legacy 30-day grace-period sweep below.
// Returns the number of owned workspaces removed.
function purgeUser(db, userId, email) {
  const wsIds = ownedWorkspaceIds(db, userId);
  const ph = wsIds.length ? wsIds.map(() => '?').join(',') : 'NULL';
  db.savepoint(() => {
    if (wsIds.length) {
      // Retain payment_events for accounting — anonymize the workspace link.
      db.prepare(`UPDATE payment_events SET workspace_id = NULL WHERE workspace_id IN (${ph})`).run(...wsIds);
      // Children first (changes via competitors), then the rest.
      db.prepare(`DELETE FROM changes WHERE competitor_id IN (SELECT id FROM competitors WHERE workspace_id IN (${ph}))`).run(...wsIds);
      for (const t of ['generated_playbooks', 'deals', 'tracked_meetings', 'calendar_connections', 'slack_installations', 'correlations', 'pattern_alerts', 'competitors', 'workspace_members']) {
        db.prepare(`DELETE FROM ${t} WHERE workspace_id IN (${ph})`).run(...wsIds);
      }
      db.prepare(`DELETE FROM workspaces WHERE id IN (${ph})`).run(...wsIds);
    }
    // Personal, user-scoped data.
    db.prepare('DELETE FROM user_context WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_voice_profile WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM settings WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM otp_codes WHERE email = ?').run(email);
    db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  return wsIds.length;
}

// ── GET /api/account/export ───────────────────────────────────────────────────
router.get('/export', (req, res) => {
  const db = getDb();
  const userId = req.userId;
  const wsIds = ownedWorkspaceIds(db, userId);
  const placeholders = wsIds.length ? wsIds.map(() => '?').join(',') : 'NULL';
  const inWs = (sql) => db.prepare(sql).all(...wsIds);

  const user = db.prepare('SELECT id, email, name, tier, email_verified, last_login, created_at, deletion_requested_at, deletion_scheduled_at FROM users WHERE id = ?').get(userId);

  // calendar/slack token fields are masked — presence only, never the value.
  const calendar = inWs(`SELECT * FROM calendar_connections WHERE workspace_id IN (${placeholders})`).map(c => {
    const { access_token_enc, refresh_token_enc, ...rest } = c;
    return { ...rest, encrypted_access_token_present: !!access_token_enc, encrypted_refresh_token_present: !!refresh_token_enc };
  });
  const slack = inWs(`SELECT * FROM slack_installations WHERE workspace_id IN (${placeholders})`).map(s => {
    const { bot_token_enc, ...rest } = s;
    return { ...rest, encrypted_bot_token_present: !!bot_token_enc };
  });

  const data = {
    export_metadata: {
      generated_at: new Date().toISOString(),
      user_id: userId,
      note: 'Calendar and Slack OAuth tokens are intentionally masked (presence only). Payment events are retained for accounting and are not included here.',
    },
    user,
    workspaces: db.prepare(`SELECT * FROM workspaces WHERE id IN (${placeholders})`).all(...wsIds),
    workspace_members: inWs(`SELECT * FROM workspace_members WHERE workspace_id IN (${placeholders})`),
    competitors: inWs(`SELECT * FROM competitors WHERE workspace_id IN (${placeholders})`),
    // changes are scoped through their parent competitor's workspace (no direct column).
    changes: wsIds.length
      ? db.prepare(`SELECT ch.* FROM changes ch JOIN competitors c ON c.id = ch.competitor_id WHERE c.workspace_id IN (${placeholders})`).all(...wsIds)
      : [],
    generated_playbooks: inWs(`SELECT * FROM generated_playbooks WHERE workspace_id IN (${placeholders})`),
    deals: inWs(`SELECT * FROM deals WHERE workspace_id IN (${placeholders})`),
    tracked_meetings: inWs(`SELECT * FROM tracked_meetings WHERE workspace_id IN (${placeholders})`),
    calendar_connections: calendar,
    slack_installations: slack,
    correlations: inWs(`SELECT * FROM correlations WHERE workspace_id IN (${placeholders})`),
    pattern_alerts: inWs(`SELECT * FROM pattern_alerts WHERE workspace_id IN (${placeholders})`),
    user_context: db.prepare('SELECT * FROM user_context WHERE user_id = ?').get(userId) || null,
    user_voice_profile: db.prepare('SELECT * FROM user_voice_profile WHERE user_id = ?').get(userId) || null,
    settings: db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId) || null,
    audit_log: db.prepare('SELECT id, workspace_id, event_type, event_data, occurred_at FROM audit_log WHERE user_id = ? ORDER BY occurred_at').all(userId),
  };

  logAudit({ workspaceId: req.workspaceId, userId, eventType: 'data_export_requested', req });

  const filename = `nivaria-data-export-${userId}-${Date.now()}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(data, null, 2));
});

// ── POST /api/account/delete ──────────────────────────────────────────────────
// IMMEDIATE, irreversible hard delete — no soft delete, no recovery. Requires
// BOTH fresh-auth (the account password) and a typed-email confirmation that
// matches the account email, so neither a hijacked session nor a stray click can
// destroy the account on its own. Any active Lemon Squeezy subscription is
// cancelled (at period end) BEFORE the data is removed. The session is destroyed
// so the user is logged out, and the client is told to land on the landing page.
router.post('/delete', limits.accountDelete, async (req, res) => {
  if (!passwordOk(req)) return res.status(401).json({ error: 'Password is incorrect.' });

  const db = getDb();
  const userId = req.userId;
  const accountEmail = String(req.user.email || '');

  // Type-to-confirm: the submitted email must match the account email exactly
  // (case-insensitively). Guards against an accidental, unintended deletion.
  const confirmEmail = String(req.body?.confirmEmail || '').trim().toLowerCase();
  if (!confirmEmail || confirmEmail !== accountEmail.toLowerCase()) {
    return res.status(400).json({ error: 'The email you typed does not match your account email.' });
  }

  // 1. Cancel any active Lemon Squeezy subscription FIRST (best-effort). Cancel
  //    at period end so the user keeps the Pro access they already paid for.
  try {
    const subs = db.prepare('SELECT subscription_id FROM workspaces WHERE owner_user_id = ? AND subscription_id IS NOT NULL').all(userId);
    for (const s of subs) { try { await ls.cancelAtPeriodEnd(s.subscription_id); } catch (_) {} }
  } catch (_) {}

  // 2. Hard-delete every trace. Capture a privacy-preserving email hash for the
  //    retained audit record BEFORE the row is gone (raw email is never logged).
  const emailHash = hashEmail(accountEmail);
  let workspaces = 0;
  try {
    workspaces = purgeUser(db, userId, accountEmail);
  } catch (e) {
    console.error(`account hard-delete failed for user ${userId} (rolled back):`, e.message);
    return res.status(500).json({ error: 'Could not delete your account. Please try again or contact support.' });
  }

  // 3. Append-only "Account deleted" audit entry (retained; user_id kept as an
  //    integer ref, email stored only as a salted hash).
  logAudit({ workspaceId: req.workspaceId, userId, eventType: 'account_deletion_completed', eventData: { emailHash, workspaces, immediate: true }, req });

  // 4. Log the user out and point the client at the landing page.
  req.session.destroy(() => {
    res.clearCookie('cs.sid');
    res.json({ ok: true, deleted: true, redirect: '/', message: 'Your account and all associated data have been permanently deleted.' });
  });
});

// ── PUT /api/account/profile ──────────────────────────────────────────────────
// Update the friendly display name and/or timezone. Backs both the settings
// "Profile" card and the dashboard one-time "add your name" prompt shown to
// pre-existing users who signed up before the name field existed. Partial:
// each field is only written when supplied.
router.put('/profile', (req, res) => {
  const db = getDb();
  const sets = [];
  const args = [];

  if (req.body?.firstName !== undefined) {
    const err = validateFirstName(req.body.firstName);
    if (err) return res.status(400).json({ error: err });
    const name = String(req.body.firstName).trim();
    // Keep the legacy required `name` column in step with the friendly name.
    sets.push('first_name = ?', 'name = ?');
    args.push(name, name);
  }
  if (req.body?.timezone !== undefined) {
    sets.push('timezone = ?');
    args.push(sanitizeTimezone(req.body.timezone));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  args.push(req.userId);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  const user = db.prepare('SELECT id, email, name, first_name, timezone FROM users WHERE id = ?').get(req.userId);
  res.json({ ok: true, user });
});

// ── POST /api/account/dashboard-visited ─────────────────────────────────────────
// Idempotently records that the user has opened the dashboard at least once,
// which flips future greetings from a "welcome" variant to "welcome back".
router.post('/dashboard-visited', (req, res) => {
  getDb().prepare('UPDATE users SET has_visited_dashboard = 1 WHERE id = ?').run(req.userId);
  res.json({ ok: true });
});

// ── POST /api/account/delete/cancel (in-app, fresh auth) ────────────────────────
router.post('/delete/cancel', (req, res) => {
  if (!passwordOk(req)) return res.status(401).json({ error: 'Password is incorrect.' });
  const db = getDb();
  db.prepare('UPDATE users SET deletion_requested_at = NULL, deletion_scheduled_at = NULL, deletion_cancel_token = NULL WHERE id = ?').run(req.userId);
  logAudit({ workspaceId: req.workspaceId, userId: req.userId, eventType: 'account_deletion_cancelled', req });
  res.json({ ok: true, message: 'Account deletion cancelled.' });
});

// ── Public email-link restore (GET, token-authenticated) ────────────────────────
// Mounted in server.js as GET /api/account/delete/cancel (no session required).
function restoreByToken(req, res) {
  const token = String(req.query?.token || '');
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  if (!token || token.length !== 64) return res.redirect('/login?restore=invalid');
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE deletion_cancel_token = ? AND deletion_requested_at IS NOT NULL').get(token);
  if (!user) return res.redirect('/login?restore=invalid');
  db.prepare('UPDATE users SET deletion_requested_at = NULL, deletion_scheduled_at = NULL, deletion_cancel_token = NULL WHERE id = ?').run(user.id);
  logAudit({ userId: user.id, eventType: 'account_deletion_cancelled', eventData: { via: 'email_link' }, req });
  return res.redirect('/login?restore=ok');
}

// ── 30-day deletion sweep (called by the scheduler; also runnable standalone) ───
// Hard-deletes users whose grace period has elapsed, along with their owned
// workspaces and all workspace-scoped data. payment_events are RETAINED but
// anonymized (workspace_id → NULL). Returns the number of accounts deleted.
function processScheduledDeletions() {
  const db = getDb();
  const due = db.prepare(`
    SELECT id, email FROM users
    WHERE deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at <= CURRENT_TIMESTAMP
  `).all();
  let deleted = 0;

  for (const u of due) {
    try {
      const workspaces = purgeUser(db, u.id, u.email);
      // audit_log is append-only and retained (user_id kept as an integer ref).
      logAudit({ userId: u.id, eventType: 'account_deletion_completed', eventData: { workspaces } });
      deleted++;
    } catch (e) {
      console.error(`account deletion failed for user ${u.id} (rolled back):`, e.message);
    }
  }
  return deleted;
}

// workspace_members has no workspace_id? It does (workspace_id column). competitors
// has workspace_id (added by migration). The DELETE loop relies on that.

module.exports = router;
module.exports.restoreByToken = restoreByToken;
module.exports.processScheduledDeletions = processScheduledDeletions;
