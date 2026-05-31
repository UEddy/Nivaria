// Phase 10 — tier enforcement (server-side source of truth).
//
// The frontend's tier display is advisory only. Every Pro-gated route MUST call
// canWorkspaceAccess()/requireFeature() server-side. Limits are keyed by the
// workspace's EFFECTIVE tier (see getWorkspaceTier — honours cancellation grace
// periods so a cancelled-but-still-paid workspace keeps Pro until period end).

const { getDb } = require('../db');
const { logAudit } = require('./audit');

const TIER_LIMITS = {
  free:     { maxCompetitors: 1,  dailyMonitoring: false, webhooks: false, calendar: false, playbooks: false, winLossCorrelation: false, historicalContext: false },
  pro:      { maxCompetitors: 10, dailyMonitoring: true,  webhooks: true,  calendar: true,  playbooks: true,  winLossCorrelation: true,  historicalContext: true  },
  // Team/Business are waitlist-only in Phase 10 (no active checkout), but the
  // limits are defined so a manually-granted workspace behaves sensibly.
  team:     { maxCompetitors: -1, dailyMonitoring: true,  webhooks: true,  calendar: true,  playbooks: true,  winLossCorrelation: true,  historicalContext: true  },
  business: { maxCompetitors: -1, dailyMonitoring: true,  webhooks: true,  calendar: true,  playbooks: true,  winLossCorrelation: true,  historicalContext: true  },
};

// Backend owns the gate-modal copy; the frontend renders message + upgradeUrl
// straight from the 402 body.
const FEATURE_INFO = {
  add_competitor:       { message: 'You’ve reached your plan’s competitor limit. Upgrade to Pro to track more.' },
  daily_monitoring:     { message: 'Automatic daily monitoring is a Pro feature.' },
  webhooks:             { message: 'Slack & Discord alert webhooks are a Pro feature.' },
  calendar:             { message: 'Pre-meeting calendar briefings are a Pro feature.' },
  playbooks:            { message: 'AI outreach playbooks are a Pro feature.' },
  win_loss_correlation: { message: 'Win/loss correlation analysis is a Pro feature.' },
  historical_context:   { message: 'Historical pattern analysis is a Pro feature.' },
};

const FEATURE_TO_LIMIT = {
  daily_monitoring: 'dailyMonitoring',
  webhooks: 'webhooks',
  calendar: 'calendar',
  playbooks: 'playbooks',
  win_loss_correlation: 'winLossCorrelation',
  historical_context: 'historicalContext',
};

// Effective tier, accounting for cancellation grace periods.
function getWorkspaceTier(workspaceId) {
  if (!workspaceId) return 'free';
  const w = getDb().prepare('SELECT subscription_tier, subscription_status, subscription_current_period_end FROM workspaces WHERE id = ?').get(workspaceId);
  if (!w) return 'free';
  const tier = w.subscription_tier || 'free';
  if (tier === 'free') return 'free';
  if (w.subscription_status === 'expired') return 'free';

  // Cancelled (scheduled to end) but still inside the paid period → keep tier.
  // Once the period has elapsed for a cancelled/expired sub → drop to free.
  if (w.subscription_current_period_end) {
    const ended = new Date(String(w.subscription_current_period_end).replace(' ', 'T')).getTime() < Date.now();
    if (ended && (w.subscription_status === 'cancelled' || w.subscription_status === 'expired')) {
      return 'free';
    }
  }
  // past_due → keep tier (Lemon Squeezy dunning retries); paused → keep tier
  // visible (read-only handled at the UI layer).
  return tier;
}

function getLimits(workspaceId) {
  return TIER_LIMITS[getWorkspaceTier(workspaceId)] || TIER_LIMITS.free;
}

function canWorkspaceAccess(workspaceId, feature) {
  const key = FEATURE_TO_LIMIT[feature];
  if (!key) return false;
  return !!getLimits(workspaceId)[key];
}

function maxCompetitors(workspaceId) {
  return getLimits(workspaceId).maxCompetitors;
}

// True if the workspace can add one more competitor at its current count.
function canAddCompetitor(workspaceId, currentCount) {
  const max = maxCompetitors(workspaceId);
  if (max === -1) return true;
  return currentCount < max;
}

// Standard 402 body. Backend controls all gate messaging.
function upgradeRequired(res, feature) {
  return res.status(402).json({
    error: 'upgrade_required',
    feature,
    message: (FEATURE_INFO[feature] || {}).message || 'This is a Pro feature.',
    upgradeUrl: '/app#/plans',
  });
}

// Express middleware: deny with 402 + a gate_violation audit entry.
function requireFeature(feature) {
  return (req, res, next) => {
    const wsId = req.workspaceId;
    if (wsId && canWorkspaceAccess(wsId, feature)) return next();
    logAudit({ workspaceId: wsId, userId: req.userId, eventType: 'gate_violation', eventData: { feature }, req });
    return upgradeRequired(res, feature);
  };
}

module.exports = {
  TIER_LIMITS, FEATURE_INFO,
  getWorkspaceTier, getLimits, canWorkspaceAccess,
  maxCompetitors, canAddCompetitor, upgradeRequired, requireFeature,
};
