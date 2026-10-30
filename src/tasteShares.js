// Taste Gap: public, read-only links to a finished brief, and the compact
// summary that goes to Slack or Discord.
//
// A share is a row in taste_shares with an unguessable token (24 random
// bytes, base64url). /share/<token> shows the brief, map and chart to anyone
// with the link, logged out; the owner can revoke it, and a revoked or
// unknown token answers 404. Asking for a link again returns the owner's
// active one rather than minting another.
//
// Owner: the account that made the link. On the shared demo account every
// judge is the same user, so the owner is narrowed to the browser session
// (owner_session, a hash of the session id): one judge cannot see or revoke
// another's link. A featured brief can be shared by anyone; when the featured
// script rewrites it, its links follow the new brief (tasteRuns.runExample).
//
// What a link exposes: the brand, rivals and city, the brief and the chart
// data, and when it was written. Never the trace, the model, the server's
// warnings, the owner or anything else on the row.

const crypto = require('crypto');
const { getDb } = require('./db');
const { sanitizeCopy } = require('./lib/sanitizeText');
const { isDemoEmail } = require('./lib/demoAccount');
const display = require('./taste/display');

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

function appUrl() {
  return String(process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/+$/, '');
}

const shareUrl = token => appUrl() + '/share/' + token;

// Who owns links made in this request: the account, plus the session on the
// shared demo account.
function ownerOf(req) {
  const demo = isDemoEmail(req.user?.email);
  return {
    userId: req.userId,
    session: demo && req.sessionID ? crypto.createHash('sha256').update('share|' + req.sessionID).digest('hex').slice(0, 32) : null,
  };
}

function activeShare(runId, owner) {
  return getDb().prepare(
    'SELECT token, created_at FROM taste_shares WHERE run_id = ? AND created_by = ? AND owner_session IS ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(runId, owner.userId, owner.session) || null;
}

const publicShare = row => (row ? { url: shareUrl(row.token), token: row.token, created_at: row.created_at } : null);

function getShare(runId, owner) {
  return publicShare(activeShare(runId, owner));
}

// The owner's active link for this run, made now if there is none.
function createShare(runId, owner) {
  const existing = activeShare(runId, owner);
  if (existing) return publicShare(existing);
  const token = crypto.randomBytes(24).toString('base64url');
  getDb().prepare('INSERT INTO taste_shares (token, run_id, created_by, owner_session) VALUES (?, ?, ?, ?)')
    .run(token, runId, owner.userId, owner.session);
  return publicShare(activeShare(runId, owner));
}

// Revoke the owner's active link for this run. True when there was one.
function revokeShare(runId, owner) {
  const existing = activeShare(runId, owner);
  if (!existing) return false;
  getDb().prepare('UPDATE taste_shares SET revoked_at = CURRENT_TIMESTAMP WHERE token = ?').run(existing.token);
  return true;
}

// The brief behind a live link, with only what a public page needs, or null.
function sharedRun(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = getDb().prepare(`
    SELECT r.brand, r.rivals, r.city, r.created_at, r.finished_at, r.brief, r.data
    FROM taste_shares s JOIN taste_runs r ON r.id = s.run_id
    WHERE s.token = ? AND s.revoked_at IS NULL AND r.status = 'done'
  `).get(token);
  if (!row) return null;
  return {
    status: 'done',
    brand: row.brand,
    rivals: parseJson(row.rivals, []),
    city: row.city,
    created_at: row.created_at,
    finished_at: row.finished_at,
    brief: display.restoreAmpersands(parseJson(row.brief, null), parseJson(row.data, null)),
    data: parseJson(row.data, null),
  };
}

// ── The Slack and Discord summary ─────────────────────────────────────────────
// The headline, the top three win-first picks each with its strongest Qloo
// numbers, and the link. Text is ours or Qloo's; it goes through sanitizeCopy
// like every other model-written string (CLAUDE.md no-dash rule).

const pts = x => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) : null);

function evidenceLine(e, brief) {
  const rival = (brief.rivals || []).find(r => r.entity_id === e.rival_id)?.name || 'Rival';
  const ours = brief.brand?.name || 'us';
  const name = e.kind === 'cell' ? (e.label || e.neighborhood || e.area || 'one map area') : e.name;
  return name + ' (' + rival + ' ' + pts(e.rival_affinity) + ', ' + ours + ' ' + pts(e.our_affinity) + ', gap ' + pts(e.gap) + ')';
}

function briefSummary(run, url) {
  const b = run.brief;
  const pair = run.brand + ' vs ' + run.rivals.join(' and ') + (run.city ? ' in ' + run.city : '');
  const picks = (b.win_first || []).slice(0, 3).map(w => {
    const evidence = (w.evidence || []).filter(e => pts(e.gap) != null).slice(0, 2).map(e => evidenceLine(e, b));
    return {
      rank: w.rank,
      segment: sanitizeCopy(w.segment || ''),
      hook: sanitizeCopy(w.campaign_hook || ''),
      numbers: evidence.length ? sanitizeCopy('Qloo: ' + evidence.join('; ')) : '',
    };
  });
  return { pair: sanitizeCopy(pair), headline: sanitizeCopy(b.headline || ''), picks, url };
}

module.exports = { appUrl, ownerOf, getShare, createShare, revokeShare, sharedRun, briefSummary, shareUrl };
