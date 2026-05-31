// Phase 10 — Team/Business tier waitlist capture. PUBLIC endpoint (a visitor on
// the pricing page may not be logged in). Rate-limited to 5/IP/hour upstream.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_TIERS = new Set(['team', 'business']);
// Strip ASCII control characters (keep normal whitespace) from free text.
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// POST /api/waitlist  { email, tier, teamSizeEstimate?, useCase? }
// → { success: true, alreadySignedUp: boolean }
router.post('/', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const tier = String(req.body?.tier || '').trim().toLowerCase();

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!ALLOWED_TIERS.has(tier)) {
    return res.status(400).json({ error: 'tier must be "team" or "business".' });
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

  const db = getDb();
  const existing = db.prepare('SELECT id FROM waitlist_signups WHERE email = ? AND tier = ?').get(email, tier);
  if (existing) {
    return res.json({ success: true, alreadySignedUp: true });
  }

  try {
    db.prepare(`
      INSERT INTO waitlist_signups (email, tier, team_size_estimate, use_case, signed_up_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(email, tier, teamSize, useCase);
    res.json({ success: true, alreadySignedUp: false });
  } catch (e) {
    // UNIQUE(email,tier) race → treat as already signed up (graceful).
    res.json({ success: true, alreadySignedUp: true });
  }
});

module.exports = router;
