const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

function parseChange(c) {
  return {
    ...c,
    analysis: c.analysis ? JSON.parse(c.analysis) : null,
    talking_points: c.talking_points ? JSON.parse(c.talking_points) : [],
    diff_summary: c.diff_summary ? JSON.parse(c.diff_summary) : null,
  };
}

router.get('/', (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const threat = req.query.threat;
  const competitorId = req.query.competitor_id;

  const conditions = ['c.user_id = ?'];
  const params = [req.userId];

  if (threat && ['low', 'medium', 'high'].includes(threat)) {
    conditions.push('ch.threat_level = ?');
    params.push(threat);
  }
  if (competitorId) {
    conditions.push('ch.competitor_id = ?');
    params.push(competitorId);
  }

  const where = conditions.join(' AND ');

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ${where}
  `).get(...params).n;

  const rows = db.prepare(`
    SELECT ch.id, ch.competitor_id, ch.threat_level, ch.headline, ch.recommended_response,
      ch.talking_points, ch.analysis, ch.diff_summary, ch.detected_at,
      c.name AS competitor_name, c.url AS competitor_url
    FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ${where}
    ORDER BY ch.detected_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ changes: rows.map(parseChange), total, page, limit, pages: Math.ceil(total / limit) });
});

router.get('/stats', (req, res) => {
  const db = getDb();
  const uid = req.userId;

  const total_competitors = db.prepare('SELECT COUNT(*) AS n FROM competitors WHERE user_id = ?').get(uid).n;
  const active_competitors = db.prepare('SELECT COUNT(*) AS n FROM competitors WHERE user_id = ? AND active = 1').get(uid).n;
  const total_changes = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id WHERE c.user_id = ?
  `).get(uid).n;
  const changes_this_week = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND ch.detected_at >= datetime('now', '-7 days')
  `).get(uid).n;
  const high_threats = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND ch.threat_level = 'high'
  `).get(uid).n;
  const medium_threats = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND ch.threat_level = 'medium'
  `).get(uid).n;

  res.json({ total_competitors, active_competitors, total_changes, changes_this_week, high_threats, medium_threats });
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT ch.*, c.name AS competitor_name, c.url AS competitor_url, c.description AS competitor_description
    FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ch.id = ? AND c.user_id = ?
  `).get(req.params.id, req.userId);

  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(parseChange(row));
});

module.exports = router;
