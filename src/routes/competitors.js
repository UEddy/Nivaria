const express = require('express');
const router  = express.Router();
const { getDb }            = require('../db');
const { checkCompetitor }  = require('../scheduler');
const { canAddCompetitor } = require('../payments');

// ── Input validation ───────────────────────────────────────────────────────────

function validateCompetitorUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return 'URL must use http or https';
    if (u.hostname.length < 2) return 'URL must have a valid hostname';
    return null; // valid
  } catch {
    return 'Invalid URL format';
  }
}

// ── Routes — all queries include user_id to prevent IDOR ──────────────────────

router.get('/', (req, res) => {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM changes WHERE competitor_id = c.id) AS change_count,
      (SELECT headline   FROM changes WHERE competitor_id = c.id ORDER BY detected_at DESC LIMIT 1) AS last_headline,
      (SELECT threat_level FROM changes WHERE competitor_id = c.id ORDER BY detected_at DESC LIMIT 1) AS last_threat,
      (SELECT detected_at  FROM changes WHERE competitor_id = c.id ORDER BY detected_at DESC LIMIT 1) AS last_change_at
    FROM competitors c
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.userId);
  res.json(rows);
});

router.post('/', (req, res) => {
  const db          = getDb();
  const name        = String(req.body.name        || '').trim();
  const url         = String(req.body.url         || '').trim();
  const description = String(req.body.description || '').trim();

  // Required fields
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });

  // Length limits
  if (name.length        > 100)  return res.status(400).json({ error: 'name must be 100 characters or fewer' });
  if (url.length         > 2048) return res.status(400).json({ error: 'url must be 2048 characters or fewer' });
  if (description.length > 500)  return res.status(400).json({ error: 'description must be 500 characters or fewer' });

  // URL format
  const urlError = validateCompetitorUrl(url);
  if (urlError) return res.status(400).json({ error: urlError });

  const user  = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const count = db.prepare('SELECT COUNT(*) AS n FROM competitors WHERE user_id = ?').get(req.userId).n;

  if (!canAddCompetitor(user, count)) {
    return res.status(403).json({
      error: `Your ${user.tier} plan supports up to ${user.tier === 'free' ? 1 : 10} competitor(s). Upgrade to add more.`,
      upgrade_required: true,
    });
  }

  const result = db.prepare(
    'INSERT INTO competitors (user_id, name, url, description) VALUES (?, ?, ?, ?)'
  ).run(req.userId, name, url, description || null);

  res.status(201).json(db.prepare('SELECT * FROM competitors WHERE id = ?').get(result.lastInsertRowid));
});

router.get('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT id FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM competitors WHERE id = ?').run(row.id);
  res.json({ success: true });
});

router.put('/:id/toggle', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const newActive = row.active ? 0 : 1;
  db.prepare('UPDATE competitors SET active = ? WHERE id = ?').run(newActive, row.id);
  res.json({ active: !!newActive });
});

router.post('/:id/check', async (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });

  // Respond immediately; run check in background
  res.json({ message: 'Check started', competitor_id: row.id });

  try {
    await checkCompetitor(row, db);
  } catch (err) {
    console.error(`Manual check failed for competitor ${row.id}:`, err.message);
  }
});

module.exports = router;
