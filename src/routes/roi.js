// Phase 9 — /api/roi routes. Mounted with requireAuth + csrfProtect.
// GET /            → full ROI dashboard (recomputes correlations fresh, no AI)
// POST /alerts     → subscribe to "alert me when this competitor repeats this move"
// DELETE /alerts   → unsubscribe
//
// All queries are user-scoped; a user only ever sees their own correlations.

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');
const { getRoiDashboard, getRevenueAtRiskCached, PATTERN_TYPES } = require('../correlationEngine');

const VALID_PATTERN_TYPES = new Set(Object.values(PATTERN_TYPES));

router.get('/', (req, res) => {
  try {
    res.json(getRoiDashboard(req.userId));
  } catch (e) {
    console.error('[roi] dashboard error:', e.message);
    res.status(500).json({ error: 'Could not compute ROI dashboard.' });
  }
});

// Lightweight headline for the main dashboard widget — reads the persisted
// correlations (no recompute), so it's cheap on every dashboard load.
router.get('/summary', (req, res) => {
  res.json(getRevenueAtRiskCached(req.userId));
});

// Subscribe to a forward-looking alert for a (competitor, pattern_type).
router.post('/alerts', (req, res) => {
  const db = getDb();
  const competitorId = parseInt(req.body.competitor_id, 10);
  const patternType  = String(req.body.pattern_type || '');

  if (!Number.isInteger(competitorId)) return res.status(400).json({ error: 'competitor_id is required' });
  if (!VALID_PATTERN_TYPES.has(patternType)) return res.status(400).json({ error: 'Unknown pattern_type' });

  const own = db.prepare('SELECT id FROM competitors WHERE id = ? AND user_id = ?').get(competitorId, req.userId);
  if (!own) return res.status(404).json({ error: 'Competitor not found' });

  db.prepare(`
    INSERT INTO pattern_alerts (user_id, competitor_id, pattern_type)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, competitor_id, pattern_type) DO NOTHING
  `).run(req.userId, competitorId, patternType);

  res.json({ success: true, alert_active: true });
});

router.delete('/alerts', (req, res) => {
  const db = getDb();
  const competitorId = parseInt(req.body.competitor_id, 10);
  const patternType  = String(req.body.pattern_type || '');
  if (!Number.isInteger(competitorId)) return res.status(400).json({ error: 'competitor_id is required' });

  db.prepare('DELETE FROM pattern_alerts WHERE user_id = ? AND competitor_id = ? AND pattern_type = ?')
    .run(req.userId, competitorId, patternType);
  res.json({ success: true, alert_active: false });
});

module.exports = router;
