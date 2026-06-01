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

  const filename = `foresight-data-export-${userId}-${Date.now()}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(data, null, 2));
});

// ── POST /api/account/delete ──────────────────────────────────────────────────
router.post('/delete', limits.accountDelete, async (req, res) => {
  if (!passwordOk(req)) return res.status(401).json({ error: 'Password is incorrect.' });
  const db = getDb();
  const userId = req.userId;

  const now = new Date();
  const scheduled = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
  const token = crypto.randomBytes(32).toString('hex');
  const ts = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`UPDATE users SET deletion_requested_at = ?, deletion_scheduled_at = ?, deletion_cancel_token = ? WHERE id = ?`)
    .run(ts(now), ts(scheduled), token, userId);

  // Best-effort: cancel any active Lemon Squeezy subscription on owned workspaces.
  try {
    const subs = db.prepare('SELECT subscription_id FROM workspaces WHERE owner_user_id = ? AND subscription_id IS NOT NULL').all(userId);
    for (const s of subs) { try { await ls.cancelAtPeriodEnd(s.subscription_id); } catch (_) {} }
  } catch (_) {}

  // Confirmation email with cancellation link (best-effort).
  try {
    const { sendAccountDeletionEmail } = require('../email');
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const cancelUrl = `${appUrl}/api/account/delete/cancel?token=${token}`;
    await sendAccountDeletionEmail(req.user.email, cancelUrl, scheduled);
  } catch (e) {
    console.warn('deletion email failed (non-fatal):', e.message);
  }

  logAudit({ workspaceId: req.workspaceId, userId, eventType: 'account_deletion_requested', eventData: { scheduledAt: ts(scheduled) }, req });
  res.json({ ok: true, scheduledAt: ts(scheduled), message: `Your account is scheduled for deletion on ${ts(scheduled)}. Check your email for a cancellation link.` });
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
    const wsIds = ownedWorkspaceIds(db, u.id);
    const ph = wsIds.length ? wsIds.map(() => '?').join(',') : 'NULL';
    try {
      // Atomic + save-safe (savepoint suppresses mid-transaction export()).
      db.savepoint(() => {
        if (wsIds.length) {
          // Retain payment_events for accounting — anonymize the workspace link.
          db.prepare(`UPDATE payment_events SET workspace_id = NULL WHERE workspace_id IN (${ph})`).run(...wsIds);
          // Children first (changes via competitors), then the rest.
          db.prepare(`DELETE FROM changes WHERE competitor_id IN (SELECT id FROM competitors WHERE workspace_id IN (${ph}))`).run(...wsIds);
          // Tables scoped by a workspace_id column.
          for (const t of ['generated_playbooks', 'deals', 'tracked_meetings', 'calendar_connections', 'slack_installations', 'correlations', 'pattern_alerts', 'competitors', 'workspace_members']) {
            db.prepare(`DELETE FROM ${t} WHERE workspace_id IN (${ph})`).run(...wsIds);
          }
          // The workspaces table itself is keyed by `id`, not `workspace_id`.
          db.prepare(`DELETE FROM workspaces WHERE id IN (${ph})`).run(...wsIds);
        }
        // Personal, user-scoped data.
        db.prepare('DELETE FROM user_context WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM user_voice_profile WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM settings WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM otp_codes WHERE email = ?').run(u.email);
        db.prepare('DELETE FROM login_attempts WHERE email = ?').run(u.email);
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      });
      // audit_log is append-only and retained (user_id kept as an integer ref).
      logAudit({ userId: u.id, eventType: 'account_deletion_completed', eventData: { workspaces: wsIds.length } });
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
