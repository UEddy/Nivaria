// Phase 12 — developer-only admin views. Currently a single page: the
// Team/Business waitlist. Access is gated to the emails listed in the
// ADMIN_EMAILS env var (comma-separated). This is a deliberately minimal
// stand-in for a real role system (slated for a later phase).
//
// Mounted directly on the app (not as a sub-router) so the paths stay /admin
// and /admin/waitlist, registered BEFORE the SPA catch-all in server.js.

const { getDb } = require('../db');
const { logAudit } = require('../lib/audit');

// Parse ADMIN_EMAILS once at module load. Comma-separated, case-insensitive,
// whitespace-trimmed. Empty/unset → nobody is an admin (safe default).
function getAdminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdminEmail(email) {
  if (!email) return false;
  return getAdminEmails().includes(String(email).trim().toLowerCase());
}

// Minimal HTML escaper for user-controlled values rendered into the table.
function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Guard: must be logged in (else → /login) AND an admin email (else → 403).
// Resolves req.adminUser on success. Used for browser-facing /admin pages, so
// it redirects rather than returning a JSON 401 the way the API requireAuth does.
function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }
  const user = getDb().prepare('SELECT id, email FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.redirect('/login');
  if (!isAdminEmail(user.email)) {
    return res.status(403).type('html').send(renderDenied());
  }
  req.adminUser = user;
  next();
}

function renderShell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Nivaria Admin: ${esc(title)}</title>
  <style>
    :root {
      --bg: #000000; --bg-2: #0A0A0A; --bg-card: rgba(255,255,255,0.04);
      --border: rgba(255,255,255,0.10); --txt: #F0F0F8; --txt-2: #888899;
      --txt-3: #555566; --accent: #818CF8;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      background: var(--bg); color: var(--txt); line-height: 1.6;
      -webkit-font-smoothing: antialiased; padding: 40px 24px;
    }
    .admin-wrap { max-width: 1080px; margin: 0 auto; }
    .admin-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
    h1 { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; }
    .admin-sub { color: var(--txt-2); font-size: 0.875rem; margin-bottom: 28px; }
    .admin-count { color: var(--accent); font-weight: 700; }
    table { width: 100%; border-collapse: collapse; background: var(--bg-2); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; font-size: 0.875rem; }
    thead th { text-align: left; padding: 12px 16px; background: var(--bg-card); color: var(--txt-2); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.6875rem; border-bottom: 1px solid var(--border); }
    tbody td { padding: 12px 16px; border-bottom: 1px solid var(--border); color: var(--txt); vertical-align: top; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: rgba(255,255,255,0.02); }
    .tier-pill { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .tier-team { background: rgba(129,140,248,0.16); color: #A5B4FC; }
    .tier-business { background: rgba(16,185,129,0.16); color: #34D399; }
    .muted { color: var(--txt-3); }
    .empty { padding: 40px 16px; text-align: center; color: var(--txt-2); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .back { display: inline-block; margin-top: 24px; font-size: 0.8125rem; color: var(--txt-2); }
  </style>
</head>
<body>
  <div class="admin-wrap">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function renderDenied() {
  return renderShell('Access denied', `
    <div class="admin-head"><h1>403 — Access denied</h1></div>
    <p class="admin-sub">Your account is not authorized to view this page.</p>
    <a class="back" href="/app">&larr; Back to app</a>`);
}

function renderWaitlist(rows) {
  const body = rows.length
    ? rows.map(r => `
        <tr>
          <td class="muted">${esc(r.id)}</td>
          <td>${esc(r.email)}</td>
          <td><span class="tier-pill tier-${esc(r.tier_interest)}">${esc(r.tier_interest)}</span></td>
          <td>${esc(r.created_at)}</td>
          <td>${r.notified_at ? esc(r.notified_at) : '<span class="muted">—</span>'}</td>
        </tr>`).join('')
    : `<tr><td class="empty" colspan="5">No waitlist signups yet.</td></tr>`;

  return renderShell('Waitlist', `
    <div class="admin-head">
      <h1>Waitlist signups</h1>
      <span class="admin-sub"><span class="admin-count">${rows.length}</span> total</span>
    </div>
    <p class="admin-sub">Team and Business tier interest captured from the marketing site and in-app upgrade gate.</p>
    <table>
      <thead>
        <tr><th>id</th><th>email</th><th>tier_interest</th><th>created_at</th><th>notified_at</th></tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
    <a class="back" href="/app">&larr; Back to app</a>`);
}

function registerAdminRoutes(app) {
  // Bare /admin → the only page we have for now.
  app.get('/admin', requireAdmin, (_req, res) => res.redirect('/admin/waitlist'));

  app.get('/admin/waitlist', requireAdmin, (req, res) => {
    // Column aliases map the storage names (tier, signed_up_at) onto the
    // display contract (tier_interest, created_at).
    const rows = getDb().prepare(`
      SELECT id, email, tier AS tier_interest, signed_up_at AS created_at, notified_at
      FROM waitlist_signups
      ORDER BY signed_up_at DESC, id DESC
    `).all();

    logAudit({
      userId: req.adminUser.id,
      workspaceId: req.workspaceId || null,
      eventType: 'admin_view_waitlist',
      eventData: { count: rows.length },
      req,
    });

    res.type('html').send(renderWaitlist(rows));
  });
}

module.exports = { registerAdminRoutes, isAdminEmail, getAdminEmails };
