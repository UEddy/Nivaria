const express = require('express');
const router  = express.Router();
const { getDb, extractDomainFromUrl } = require('../db');
const { checkCompetitor }  = require('../scheduler');
const { canAddCompetitor, upgradeRequired } = require('../lib/tierLimits');
const { logAudit } = require('../lib/audit');
const { getCompetitorHistory, generatePatternCallouts } = require('../historicalContext');
const { normalizeCompetitorUrl, canonicalUrlKey } = require('../lib/urlNormalize');

// ── Input validation ───────────────────────────────────────────────────────────

// Returns the id of an existing competitor whose URL is the same site as `url`
// after normalization (scheme/www/trailing-slash insensitive, path-sensitive),
// or null. `excludeId` skips a row (used on edit so a competitor isn't flagged a
// duplicate of itself). Scoped to the user so it only considers their own list.
function findDuplicateUrl(db, userId, url, excludeId = null) {
  const key = canonicalUrlKey(url);
  if (!key) return null;
  const rows = db.prepare('SELECT id, url FROM competitors WHERE user_id = ?').all(userId);
  for (const r of rows) {
    if (excludeId != null && r.id === excludeId) continue;
    if (canonicalUrlKey(r.url) === key) return r.id;
  }
  return null;
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
  // change_count and the "last change" fields feed customer-facing counts and
  // badges, so they exclude trivial (AI-downgraded / pre-AI-gated) changes.
  // Those rows are retained in the table for audit but never surfaced to users.
  // (MEANINGFUL is a fixed literal, not user input — no injection surface.)
  const MEANINGFUL = '(is_meaningful IS NULL OR is_meaningful = 1)';
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL}) AS change_count,
      (SELECT headline     FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL} ORDER BY detected_at DESC LIMIT 1) AS last_headline,
      (SELECT threat_level FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL} ORDER BY detected_at DESC LIMIT 1) AS last_threat,
      (SELECT detected_at  FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL} ORDER BY detected_at DESC LIMIT 1) AS last_change_at
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
  if (description.length > 500)  return res.status(400).json({ error: 'description must be 500 characters or fewer' });

  // URL normalization + completion. The user may type a bare domain ("apple.com")
  // or a full URL; we complete a missing scheme to https and store the cleaned,
  // monitorable form. Length is checked inside on the raw input.
  const norm = normalizeCompetitorUrl(url);
  if (norm.error) return res.status(400).json({ error: norm.error });
  const normalizedUrl = norm.url;

  // Duplicate detection uses the same normalization, so "apple.com" is caught as
  // a duplicate of an existing "https://www.apple.com".
  if (findDuplicateUrl(db, req.userId, normalizedUrl) != null) {
    return res.status(409).json({ error: 'You are already monitoring this URL.' });
  }

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

  const domain = extractDomainFromUrl(normalizedUrl);

  const result = db.prepare(
    'INSERT INTO competitors (user_id, name, url, description, css_selector, render_mode, domain) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.userId, name, normalizedUrl, description || null, sel.value, rm.value, domain);

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
    const rawUrl = String(req.body.url).trim();
    if (!rawUrl) return res.status(400).json({ error: 'url cannot be empty' });
    // Same completion + validation as add: accept a bare domain, store the
    // cleaned URL. Length is checked inside normalizeCompetitorUrl.
    const norm = normalizeCompetitorUrl(rawUrl);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const newUrl = norm.url;
    // Reject an edit that would collide with another competitor (same normalized
    // site), excluding this row so an unchanged URL is never a self-duplicate.
    if (findDuplicateUrl(db, req.userId, newUrl, row.id) != null) {
      return res.status(409).json({ error: 'You are already monitoring this URL.' });
    }
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
