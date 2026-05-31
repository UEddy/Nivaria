// Phase 8 — /api/playbooks routes.
//
// GET    /api/changes/:changeId/playbooks
//        Returns generated playbooks for a change. User ownership is enforced
//        by joining through competitors → users.
//
// POST   /api/changes/:changeId/playbooks/generate
//        Triggers (or re-triggers) full playbook generation for a change.
//        Useful when a user changes their voice profile and wants existing
//        battle cards to reflect the new voice. Slow — returns once all
//        variants have been generated.
//
// POST   /api/playbooks/:id/regenerate
//        Regenerates a single variant with higher temperature. Bumps
//        regenerated_count.
//
// GET    /api/playbooks/recent
//        Last N playbook rows for the current user — feeds the dashboard
//        "Recent outreach generated" widget.
//
// SECURITY: every endpoint verifies user ownership of the underlying
// change_id / playbook_id. We never trust an id from the URL alone.

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');
const { requireFeature } = require('../lib/tierLimits');
const {
  generatePlaybooksForChange,
  regenerateSinglePlaybook,
  getPlaybooksForChange,
  getRecentPlaybooksForUser,
} = require('../playbooks');

function userOwnsChange(db, changeId, userId) {
  const row = db.prepare(`
    SELECT ch.id FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ch.id = ? AND c.user_id = ?
  `).get(changeId, userId);
  return !!row;
}

function userOwnsPlaybook(db, playbookId, userId) {
  const row = db.prepare(`SELECT id FROM generated_playbooks WHERE id = ? AND user_id = ?`)
    .get(playbookId, userId);
  return !!row;
}

router.get('/recent', (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
  const rows = getRecentPlaybooksForUser(req.userId, limit);
  res.json({ playbooks: rows });
});

router.get('/changes/:changeId', (req, res) => {
  const db = getDb();
  const changeId = parseInt(req.params.changeId, 10);
  if (!Number.isInteger(changeId)) return res.status(400).json({ error: 'Invalid change id' });
  if (!userOwnsChange(db, changeId, req.userId)) return res.status(404).json({ error: 'Not found' });

  const playbooks = getPlaybooksForChange(changeId, req.userId);
  res.json({ change_id: changeId, playbooks });
});

router.post('/changes/:changeId/generate', requireFeature('playbooks'), async (req, res) => {
  const db = getDb();
  const changeId = parseInt(req.params.changeId, 10);
  if (!Number.isInteger(changeId)) return res.status(400).json({ error: 'Invalid change id' });
  if (!userOwnsChange(db, changeId, req.userId)) return res.status(404).json({ error: 'Not found' });

  try {
    const result = await generatePlaybooksForChange(changeId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true, playbooks: getPlaybooksForChange(changeId, req.userId) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Playbook generation failed', code: e.code || 'playbook_error' });
  }
});

router.post('/:id/regenerate', requireFeature('playbooks'), async (req, res) => {
  const db = getDb();
  const playbookId = parseInt(req.params.id, 10);
  if (!Number.isInteger(playbookId)) return res.status(400).json({ error: 'Invalid playbook id' });
  if (!userOwnsPlaybook(db, playbookId, req.userId)) return res.status(404).json({ error: 'Not found' });

  try {
    const result = await regenerateSinglePlaybook(playbookId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    // Return the fresh row so the UI can swap it without a separate fetch.
    const fresh = db.prepare(`SELECT * FROM generated_playbooks WHERE id = ?`).get(playbookId);
    res.json({ success: true, playbook: fresh });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Regeneration failed', code: e.code || 'playbook_error' });
  }
});

module.exports = router;
