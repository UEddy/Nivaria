// Phase 6 — /api/user/context routes.
//
// GET  → returns the caller's context row (or null if not yet set)
// PUT  → upserts the row, validating enums + length caps
//
// Auth/CSRF middleware is mounted by server.js, so req.userId is guaranteed
// by the time we get here. Every query is scoped to req.userId — there is
// no path parameter for context.

const express = require('express');
const router  = express.Router();
const {
  getUserContext, saveUserContext,
  MAX_FIELD_CHARS, ALLOWED_DEAL_SIZES, ALLOWED_SALES_MOTIONS,
} = require('../userContext');

router.get('/', (req, res) => {
  const ctx = getUserContext(req.userId);
  // Empty-but-not-null shape lets the SPA show empty form fields without a
  // null-check at every property — but the `exists` flag tells callers
  // whether the user has actually saved anything yet.
  res.json({
    exists: !!ctx,
    context: ctx || {
      company_name: '', what_we_sell: '', target_icp: '', our_positioning: '',
      typical_deal_size: null, sales_motion: null,
    },
    constraints: {
      max_field_chars:     MAX_FIELD_CHARS,
      deal_sizes:          ALLOWED_DEAL_SIZES,
      sales_motions:       ALLOWED_SALES_MOTIONS,
    },
  });
});

router.put('/', (req, res) => {
  // Accept partial updates — only fields explicitly present are touched.
  const allowed = ['company_name', 'what_we_sell', 'target_icp', 'our_positioning',
                   'typical_deal_size', 'sales_motion'];
  const patch = {};
  for (const k of allowed) {
    if (k in req.body) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No context fields provided' });
  }

  const r = saveUserContext(req.userId, patch);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true, context: r.context });
});

module.exports = router;
