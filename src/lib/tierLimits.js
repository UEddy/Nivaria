// Plan enforcement (server-side source of truth).
//
// Billing was removed on 2026-10-29. Every account is on ONE fixed plan, with
// no trial, no expiry and nothing to buy, so there is no tier to resolve: the
// limits below apply to every workspace. The old subscription_* and trial_*
// columns on workspaces are legacy and no longer read (see README, "Legacy
// billing tables").
//
// The frontend's plan display is advisory only. Gated routes still call
// canWorkspaceAccess()/requireFeature() server-side, so a feature can be
// switched off for everyone by flipping its flag in PLAN.

const { getDb } = require('../db');
const { logAudit } = require('./audit');
const { isAdminEmail } = require('./adminEmails');

// ── Page limits ───────────────────────────────────────────────────────────────
// The cost unit is a monitored PAGE, not a competitor. A competitor (company)
// groups one or more pages; each page is checked and briefed individually, so
// each page carries the real per-check cost. Grouping is organizational only
// and grants NO extra monitoring: maxPages caps the total an account monitors.
//
//     monthly cost ≈ maxPages × checks-per-day × 30 × cost-per-brief
//
// Every page is checked ONCE PER DAY (src/scheduler.js, cron '0 9 * * *'), and
// nobody pays, so the cap is deliberately small.
const PLAN_NAME = 'standard';

// Maximum pages that may be grouped under a single competitor. A structural cap
// so one company cannot take the whole allowance.
const MAX_PAGES_PER_COMPETITOR = 5;

const PLAN = {
  maxPages: 5,
  dailyMonitoring: true,
  webhooks: true,
  calendar: true,
  playbooks: true,
  winLossCorrelation: true,
  historicalContext: true,
};

// Kept keyed by plan name for callers that read TIER_LIMITS directly.
const TIER_LIMITS = { [PLAN_NAME]: PLAN };

// Backend owns the limit messages; the frontend shows the message from the
// 403 body as is.
const FEATURE_INFO = {
  add_competitor:       { message: `You’ve reached the limit of ${PLAN.maxPages} monitored pages. Remove a page to add another.` },
  daily_monitoring:     { message: 'Automatic daily monitoring is not available.' },
  webhooks:             { message: 'Slack and Discord alert webhooks are not available.' },
  calendar:             { message: 'Pre-meeting calendar briefings are not available.' },
  playbooks:            { message: 'AI outreach playbooks are not available.' },
  win_loss_correlation: { message: 'Win/loss correlation analysis is not available.' },
  historical_context:   { message: 'Historical pattern analysis is not available.' },
};

const FEATURE_TO_LIMIT = {
  daily_monitoring: 'dailyMonitoring',
  webhooks: 'webhooks',
  calendar: 'calendar',
  playbooks: 'playbooks',
  win_loss_correlation: 'winLossCorrelation',
  historical_context: 'historicalContext',
};

// ── Developer override (Phase 12) ─────────────────────────────────────────────
// is_developer is a per-user flag (set via /admin/set-developer) that grants
// every feature and lifts the page caps. A hard override, not subject to
// expiration.
function isDeveloperUser(userId) {
  if (!userId) return false;
  const u = getDb().prepare('SELECT is_developer FROM users WHERE id = ?').get(userId);
  return !!(u && u.is_developer);
}

// Resolve the override via a workspace's owner, so it applies both in request
// handlers and in the background scheduler (which only has workspace_id).
function workspaceOwnerIsDeveloper(workspaceId) {
  if (!workspaceId) return false;
  const w = getDb().prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(workspaceId);
  return w ? isDeveloperUser(w.owner_user_id) : false;
}

// ── Admin-account override (page caps only) ───────────────────────────────────
// A workspace whose OWNER is an admin (their email is in ADMIN_EMAILS, the same
// gate that guards /admin/*) has no page cap, so the account holder can run
// uncapped demos. It changes nothing else.
function workspaceOwnerIsAdmin(workspaceId) {
  if (!workspaceId) return false;
  const w = getDb().prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(workspaceId);
  if (!w || !w.owner_user_id) return false;
  const u = getDb().prepare('SELECT email FROM users WHERE id = ?').get(w.owner_user_id);
  return u ? isAdminEmail(u.email) : false;
}

// Every workspace is on the same plan. Kept as a function so the stats payload
// and admin views have one place to read the plan name from.
function getWorkspaceTier(_workspaceId) {
  return PLAN_NAME;
}

function getLimits(_workspaceId) {
  return PLAN;
}

function canWorkspaceAccess(workspaceId, feature) {
  if (workspaceOwnerIsDeveloper(workspaceId)) return true;
  const key = FEATURE_TO_LIMIT[feature];
  if (!key) return false;
  return !!PLAN[key];
}

// True when the workspace owner has an account-level override (developer flag or
// admin email). Both bypass page caps entirely.
function workspaceOwnerIsPrivileged(workspaceId) {
  return workspaceOwnerIsDeveloper(workspaceId) || workspaceOwnerIsAdmin(workspaceId);
}

function maxPages(_workspaceId) {
  return PLAN.maxPages;
}

// True if the workspace can add one more PAGE at its current page count.
function canAddPage(workspaceId, currentPageCount) {
  if (workspaceOwnerIsPrivileged(workspaceId)) return true;
  return currentPageCount < PLAN.maxPages;
}

// True if one more page may be added to a SINGLE competitor (group) that already
// has `currentPagesInCompetitor` pages. Account-level overrides bypass it.
function canAddPageToCompetitor(workspaceId, currentPagesInCompetitor) {
  if (workspaceOwnerIsPrivileged(workspaceId)) return true;
  return currentPagesInCompetitor < MAX_PAGES_PER_COMPETITOR;
}

// Deprecated aliases. The cost unit is a page; these keep older call sites
// working and delegate to the page-based functions.
function maxCompetitors(workspaceId)               { return maxPages(workspaceId); }
function canAddCompetitor(workspaceId, currentCount) { return canAddPage(workspaceId, currentCount); }

// Standard 403 body for a limit or a switched-off feature. There is nothing to
// upgrade to, so the body carries the message only.
function planLimitReached(res, feature) {
  return res.status(403).json({
    error: 'plan_limit',
    feature,
    message: (FEATURE_INFO[feature] || {}).message || 'This feature is not available.',
  });
}

// Express middleware: deny with 403 and a gate_violation audit entry. The
// developer override is honoured here too, since canWorkspaceAccess() bypasses
// for a developer-owned workspace.
function requireFeature(feature) {
  return (req, res, next) => {
    const wsId = req.workspaceId;
    if (wsId && canWorkspaceAccess(wsId, feature)) return next();
    logAudit({ workspaceId: wsId, userId: req.userId, eventType: 'gate_violation', eventData: { feature }, req });
    return planLimitReached(res, feature);
  };
}

module.exports = {
  PLAN, PLAN_NAME, TIER_LIMITS, FEATURE_INFO, MAX_PAGES_PER_COMPETITOR,
  getWorkspaceTier, getLimits, canWorkspaceAccess,
  maxPages, canAddPage, canAddPageToCompetitor,
  maxCompetitors, canAddCompetitor, planLimitReached, requireFeature,
  isDeveloperUser, workspaceOwnerIsDeveloper, workspaceOwnerIsAdmin, workspaceOwnerIsPrivileged,
};
