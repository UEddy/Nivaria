// Phase 10 — Team/Business tier waitlist capture. PUBLIC endpoint (a visitor on
// the pricing page may not be logged in). Rate-limited to 5/IP/hour upstream.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { hashIp } = require('../lib/audit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 'trial' is a manual-access contact capture for the 14-day Pro trial (no payment
// processor / automated trial yet). It rides the same table, rate limit, and
// privacy rules as the Team/Business waitlist and is distinguished by tier='trial'.
const ALLOWED_TIERS = new Set(['team', 'business', 'trial']);
// Strip ASCII control characters (keep normal whitespace) from free text.
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// POST /api/waitlist  { email, tier|tier_interest, teamSizeEstimate?, useCase? }
// → 201 { success: true, alreadySignedUp: false, already_signed_up: false } on new
// → 200 { success: true, alreadySignedUp: true,  already_signed_up: true  } on dup
// Accepts both `tier` (in-app SPA modal) and `tier_interest` (landing page modal,
// Phase 12) for the same field. Both response casings are returned so either
// client can read the result.
router.post('/', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const tier = String(req.body?.tier || req.body?.tier_interest || '').trim().toLowerCase();

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!ALLOWED_TIERS.has(tier)) {
    return res.status(400).json({ error: 'tier must be "team", "business", or "trial".' });
  }

  // team_size_estimate only meaningful for Team; ignored otherwise.
  let teamSize = null;
  if (tier === 'team' && req.body?.teamSizeEstimate != null && req.body.teamSizeEstimate !== '') {
    const n = parseInt(req.body.teamSizeEstimate, 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 100000) teamSize = n;
  }

  // use_case: sanitized free text, capped at 2000 chars.
  let useCase = null;
  if (req.body?.useCase != null) {
    useCase = String(req.body.useCase).replace(CONTROL_CHARS, '').trim().slice(0, 2000);
    if (!useCase) useCase = null;
  }

  // Privacy: log the tier + a salted IP hash + timestamp only — NEVER the email.
  // hashIp reuses the same SHA-256 salting used by the audit log.
  const logSignup = () =>
    console.log(`[WAITLIST] tier=${tier} ip=${hashIp(req.ip) || 'unknown'} at=${new Date().toISOString()}`);

  const db = getDb();
  const existing = db.prepare('SELECT id FROM waitlist_signups WHERE email = ? AND tier = ?').get(email, tier);
  if (existing) {
    logSignup();
    return res.status(200).json({ success: true, alreadySignedUp: true, already_signed_up: true });
  }

  try {
    db.prepare(`
      INSERT INTO waitlist_signups (email, tier, team_size_estimate, use_case, signed_up_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(email, tier, teamSize, useCase);
    logSignup();
    res.status(201).json({ success: true, alreadySignedUp: false, already_signed_up: false });
  } catch (e) {
    // UNIQUE(email,tier) race → treat as already signed up (graceful).
    logSignup();
    res.status(200).json({ success: true, alreadySignedUp: true, already_signed_up: true });
  }
});

module.exports = router;
