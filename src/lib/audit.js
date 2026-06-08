// Phase 10 — security audit log.
//
// Append-only by convention: this module only ever INSERTs. Nothing in the
// codebase issues UPDATE/DELETE against audit_log.
//
// Privacy: IP addresses are stored ONLY as a salted SHA-256 hash (never raw),
// and user-agent strings are truncated to the first 100 chars. Writes are
// best-effort — a logging failure must never break the request path.

const crypto = require('crypto');
const { getDb } = require('../db');

// Canonical event types (Phase 10 spec + the operational webhook/billing
// events). Not strictly enforced at write time, but kept here as the reference.
const EVENT_TYPES = Object.freeze([
  'subscription_created', 'subscription_cancelled', 'subscription_resumed',
  'subscription_payment_failed', 'subscription_payment_succeeded',
  'gate_violation', 'login_success', 'login_failure', 'password_change',
  'account_deletion_requested', 'account_deletion_completed', 'data_export_requested',
  // Operational extras emitted by the webhook + billing layer:
  'subscription_updated', 'subscription_expired', 'subscription_paused',
  'subscription_unpaused', 'subscription_payment_recovered',
  'webhook_signature_invalid', 'account_deletion_cancelled', 'subscription_reconciled',
  // Phase 12 admin actions:
  'admin_view_waitlist', 'admin_view_users', 'set_developer_flag',
]);

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.SESSION_SECRET || 'cs-audit-salt';
  return crypto.createHash('sha256').update(String(ip) + salt).digest('hex');
}

function ipFromReq(req) {
  if (!req) return null;
  return req.ip
    || (req.headers && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : null)
    || (req.socket && req.socket.remoteAddress)
    || null;
}

// logAudit({ workspaceId, userId, eventType, eventData, req, ip, userAgent })
function logAudit(opts = {}) {
  try {
    const { workspaceId = null, userId = null, eventType, eventData = null, req = null } = opts;
    if (!eventType) return;
    const ip = opts.ip !== undefined ? opts.ip : ipFromReq(req);
    const ua = opts.userAgent !== undefined ? opts.userAgent : (req && req.headers ? req.headers['user-agent'] : null);
    getDb().prepare(`
      INSERT INTO audit_log (workspace_id, user_id, event_type, event_data, ip_hash, user_agent_short, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      workspaceId,
      userId,
      String(eventType),
      eventData == null ? null : JSON.stringify(eventData),
      hashIp(ip),
      ua ? String(ua).slice(0, 100) : null,
    );
  } catch (e) {
    console.warn('audit log write failed (non-fatal):', e.message);
  }
}

module.exports = { logAudit, hashIp, EVENT_TYPES };
