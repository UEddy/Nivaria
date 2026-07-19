// Outbound feature — the single access policy.
//
// ALL access to the Outbound feature flows through this file. There are no
// scattered `if (isAdmin)` checks anywhere else in the feature: routes use the
// `requireOutboundAccess` middleware, the admin page is gated by the existing
// `requireAdmin` (which enforces the same ADMIN_EMAILS rule), and every policy
// decision ultimately calls `canUseOutbound`.

const { isAdminEmail } = require('../lib/adminEmails');

// ── The flippable gate ─────────────────────────────────────────────────────────
// This is the ONLY place the Outbound access policy lives.
//
//   >>> CHANGE HERE TO OPEN OUTBOUND TO THE PUBLIC. <<<
//
// Phase 1 (now): admins only. The repo has no `user.isAdmin` boolean — admin
// identity is email-based (ADMIN_EMAILS), so we reuse isAdminEmail rather than
// invent a second admin concept.
//
// Phase 2 (public): return a plan check too, e.g.
//   return user?.plan === 'pro' || isAdminEmail(user?.email);
// (pair that with enabling the checkQuota body below).
function canUseOutbound(user) {
  return isAdminEmail(user?.email);
}

// ── Quota (stub) ────────────────────────────────────────────────────────────────
// Wired into the run-start endpoint from day one so Phase 2 only has to fill in
// the body. Phase 1: effectively unlimited for admins. Returns a small result
// object rather than a bare boolean so the endpoint can surface a reason/limit
// without a signature change later.
function checkQuota(_user) {
  // Phase 2: look up the user's plan limits, count runs/leads in the current
  // window, and return { allowed: false, reason, limit, used } when exceeded.
  return { allowed: true };
}

// ── Route middleware ─────────────────────────────────────────────────────────────
// Mounted AFTER requireAuth, so req.user is populated. Non-admins get a JSON 403
// (these are API endpoints, not browser pages).
function requireOutboundAccess(req, res, next) {
  if (!canUseOutbound(req.user)) {
    return res.status(403).json({ error: 'Not authorized for Outbound.' });
  }
  next();
}

module.exports = { canUseOutbound, checkQuota, requireOutboundAccess };
