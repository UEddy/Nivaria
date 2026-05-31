const express = require('express');
const router  = express.Router();
const { getDb, extractDomainFromUrl } = require('../db');
const { checkCompetitor }  = require('../scheduler');
const { canAddCompetitor, upgradeRequired } = require('../lib/tierLimits');
const { logAudit } = require('../lib/audit');
const { getCompetitorHistory, generatePatternCallouts } = require('../historicalContext');

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

// Returns { value, error }. value is always 'fetch' or 'js'; defaults to 'fetch' when missing.
function validateRenderMode(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: 'fetch', error: null };
  const s = String(raw).trim().toLowerCase();
  if (s !== 'fetch' && s !== 'js') return { value: null, error: 'render_mode must be "fetch" or "js"' };
  return { value: s, error: null };
}

// Returns { value, error }. `value === null` means "no selector / clear it".
function validateCssSelector(raw) {
  if (raw === undefined || raw === null) return { value: null, error: null };
  const s = String(raw).trim();
  if (s.length === 0) return { value: null, error: null };
  if (s.length > 200) return { value: null, error: 'CSS selector must be 200 characters or fewer' };
  // Anything that smells like injection / template breakage is rejected.
  // We are deliberately permissive about CSS punctuation: . # > + ~ [ ] = " ' : ( ) , whitespace.
  if (/<\/?script/i.test(s))                     return { value: null, error: 'CSS selector must not contain script tags' };
  if (s.includes('`'))                            return { value: null, error: 'CSS selector must not contain backticks' };
  if (/[{}]/.test(s))                             return { value: null, error: 'CSS selector must not contain { or }' };
  if (/javascript:/i.test(s))                     return { value: null, error: 'CSS selector must not contain javascript: URIs' };
  return { value: s, error: null };
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

  // Optional CSS selector
  const sel = validateCssSelector(req.body.css_selector);
  if (sel.error) return res.status(400).json({ error: sel.error });

  // Optional render_mode — defaults to 'fetch'
  const rm = validateRenderMode(req.body.render_mode);
  if (rm.error) return res.status(400).json({ error: rm.error });

  // Phase 10: competitor cap is enforced by the workspace's effective tier.
  const count = db.prepare('SELECT COUNT(*) AS n FROM competitors WHERE workspace_id = ?').get(req.workspaceId).n;
  if (!canAddCompetitor(req.workspaceId, count)) {
    logAudit({ workspaceId: req.workspaceId, userId: req.userId, eventType: 'gate_violation', eventData: { feature: 'add_competitor', count }, req });
    return upgradeRequired(res, 'add_competitor');
  }

  const domain = extractDomainFromUrl(url);

  const result = db.prepare(
    'INSERT INTO competitors (user_id, name, url, description, css_selector, render_mode, domain) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.userId, name, url, description || null, sel.value, rm.value, domain);

  res.status(201).json(db.prepare('SELECT * FROM competitors WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });

  let name        = row.name;
  let url         = row.url;
  let description = row.description;
  let cssSelector = row.css_selector;
  let renderMode  = row.render_mode || 'fetch';
  let resetHash   = false;

  if (req.body.name !== undefined) {
    name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    if (name.length > 100) return res.status(400).json({ error: 'name must be 100 characters or fewer' });
  }

  if (req.body.url !== undefined) {
    const newUrl = String(req.body.url).trim();
    if (!newUrl) return res.status(400).json({ error: 'url cannot be empty' });
    if (newUrl.length > 2048) return res.status(400).json({ error: 'url must be 2048 characters or fewer' });
    const urlError = validateCompetitorUrl(newUrl);
    if (urlError) return res.status(400).json({ error: urlError });
    if (newUrl !== url) resetHash = true;
    url = newUrl;
  }

  if (req.body.description !== undefined) {
    const d = String(req.body.description).trim();
    if (d.length > 500) return res.status(400).json({ error: 'description must be 500 characters or fewer' });
    description = d || null;
  }

  if (req.body.css_selector !== undefined) {
    const sel = validateCssSelector(req.body.css_selector);
    if (sel.error) return res.status(400).json({ error: sel.error });
    if (sel.value !== cssSelector) resetHash = true;
    cssSelector = sel.value;
  }

  if (req.body.render_mode !== undefined) {
    const rm = validateRenderMode(req.body.render_mode);
    if (rm.error) return res.status(400).json({ error: rm.error });
    // Switching render mode changes how content is extracted, so the prior
    // hash is no longer comparable — clear the baseline.
    if (rm.value !== renderMode) resetHash = true;
    renderMode = rm.value;
  }

  // Re-derive bare domain if URL changed. Cheap; keeps attendee matching in
  // sync with whatever the competitor's primary URL now points at.
  const domain = extractDomainFromUrl(url);

  // When URL, selector, or render mode changes, the previous baseline is no
  // longer comparable. Clear it so the next check captures a fresh baseline
  // rather than firing a bogus "change detected" against content from a
  // different region or rendering pipeline.
  if (resetHash) {
    db.prepare(`
      UPDATE competitors
      SET name = ?, url = ?, description = ?, css_selector = ?, render_mode = ?, domain = ?,
          last_content_hash = NULL, last_check_status = NULL, last_check_error = NULL
      WHERE id = ?
    `).run(name, url, description, cssSelector, renderMode, domain, row.id);
  } else {
    db.prepare(`
      UPDATE competitors
      SET name = ?, url = ?, description = ?, css_selector = ?, render_mode = ?, domain = ?
      WHERE id = ?
    `).run(name, url, description, cssSelector, renderMode, domain, row.id);
  }

  res.json(db.prepare('SELECT * FROM competitors WHERE id = ?').get(row.id));
});

router.get('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// Phase 5: chronological change history for a single competitor. Used by the
// timeline view on the competitor detail page. Scoped to user_id via the
// historicalContext helper (which joins on competitors.user_id).
router.get('/:id/history', (req, res) => {
  const db = getDb();
  const competitorId = parseInt(req.params.id, 10);
  if (!Number.isInteger(competitorId)) return res.status(400).json({ error: 'invalid id' });

  // 404 before fetching history — don't leak whether the id exists for a
  // different user.
  const own = db.prepare('SELECT id, name FROM competitors WHERE id = ? AND user_id = ?')
    .get(competitorId, req.userId);
  if (!own) return res.status(404).json({ error: 'Not found' });

  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 90));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 50));

  const hist = getCompetitorHistory(competitorId, { userId: req.userId, days, maxRows: limit });
  res.json({
    competitor_id: competitorId,
    competitor_name: own.name,
    days,
    count: hist.count,
    truncated: hist.truncated,
    changes: hist.changes,
  });
});

// Phase 5: auto-generated pattern callouts for the competitor detail page.
// Derived inline from the cached history — cheap, no separate job needed.
router.get('/:id/patterns', (req, res) => {
  const db = getDb();
  const competitorId = parseInt(req.params.id, 10);
  if (!Number.isInteger(competitorId)) return res.status(400).json({ error: 'invalid id' });

  const own = db.prepare('SELECT id FROM competitors WHERE id = ? AND user_id = ?')
    .get(competitorId, req.userId);
  if (!own) return res.status(404).json({ error: 'Not found' });

  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 90));
  const hist = getCompetitorHistory(competitorId, { userId: req.userId, days });
  const callouts = generatePatternCallouts(hist.changes);

  res.json({ competitor_id: competitorId, days, callouts, source_count: hist.count });
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
