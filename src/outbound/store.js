// Outbound — persistence helpers for outbound_runs and outbound_leads.
//
// Thin wrappers over the shared sql.js DatabaseWrapper (getDb()). Every write
// auto-persists to the Railway volume: Statement.run() / DatabaseWrapper.exec()
// call saveDb() internally, so there is no explicit flush to make here.
//
// NOTE: `trigger` is a SQLite keyword, so the leads column is always written and
// read as "trigger" (double-quoted). JSON columns (params, score_breakdown) are
// stored as text and parsed on read.

const { getDb } = require('../db');

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

// ── Runs ─────────────────────────────────────────────────────────────────────────

function createRun(userId, params) {
  const db = getDb();
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO outbound_runs (created_by, status, params) VALUES (?, 'pending', ?)"
  ).run(userId, JSON.stringify(params || {}));
  return getRun(lastInsertRowid);
}

function getRun(id) {
  const row = getDb().prepare('SELECT * FROM outbound_runs WHERE id = ?').get(id);
  return row ? hydrateRun(row) : null;
}

// Scope a run to its creator (defensive: even though only admins reach these
// routes today, a run id should never leak another user's run once opened up).
function getRunForUser(id, userId) {
  const row = getDb().prepare('SELECT * FROM outbound_runs WHERE id = ? AND created_by = ?').get(id, userId);
  return row ? hydrateRun(row) : null;
}

function listRunsForUser(userId, limit = 20) {
  return getDb()
    .prepare('SELECT * FROM outbound_runs WHERE created_by = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit)
    .map(hydrateRun);
}

function updateRun(id, fields) {
  const allowed = ['status', 'error_message', 'total_found', 'total_kept'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE outbound_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function hydrateRun(row) {
  return { ...row, params: parseJson(row.params, {}) };
}

// ── Leads ────────────────────────────────────────────────────────────────────────

const LEAD_INSERT_COLS = [
  'run_id', 'company', 'domain', 'category', 'stage_size', 'region',
  'trigger', 'trigger_url', 'score', 'score_breakdown', 'why_now',
  'person_name', 'person_title', 'person_seniority',
  'channel', 'handle_or_email', 'contact_status', 'backup_channel',
  'draft', 'confidence',
];

function insertLead(runId, lead) {
  const row = {
    run_id: runId,
    company: lead.company || null,
    domain: lead.domain || null,
    category: lead.category || null,
    stage_size: lead.stage_size || null,
    region: lead.region || null,
    trigger: lead.trigger || null,
    trigger_url: lead.trigger_url || null,
    score: Number.isFinite(lead.score) ? Math.round(lead.score) : 0,
    score_breakdown: JSON.stringify(lead.score_breakdown || {}),
    why_now: lead.why_now || null,
    person_name: lead.person_name || null,
    person_title: lead.person_title || null,
    person_seniority: lead.person_seniority || null,
    channel: lead.channel || null,
    handle_or_email: lead.handle_or_email || null,
    contact_status: lead.contact_status || 'manual',
    backup_channel: lead.backup_channel || null,
    draft: lead.draft || null,
    confidence: lead.confidence || null,
  };
  // Quote every column so the "trigger" keyword is handled; status/notes/
  // created_at keep their schema defaults (new / null / now).
  const cols = LEAD_INSERT_COLS.map(c => `"${c}"`).join(', ');
  const placeholders = LEAD_INSERT_COLS.map(() => '?').join(', ');
  const vals = LEAD_INSERT_COLS.map(c => row[c]);
  const { lastInsertRowid } = getDb()
    .prepare(`INSERT INTO outbound_leads (${cols}) VALUES (${placeholders})`)
    .run(...vals);
  return lastInsertRowid;
}

function listLeadsForRun(runId) {
  return getDb()
    .prepare('SELECT * FROM outbound_leads WHERE run_id = ? ORDER BY score DESC, id ASC')
    .all(runId)
    .map(hydrateLead);
}

// Pipeline view: all leads for a user's runs, newest run first then by score,
// optionally filtered by lead status.
function listLeadsForUser(userId, { status } = {}) {
  const db = getDb();
  const params = [userId];
  let sql = `SELECT l.* FROM outbound_leads l
             JOIN outbound_runs r ON r.id = l.run_id
             WHERE r.created_by = ?`;
  if (status) { sql += ' AND l.status = ?'; params.push(status); }
  sql += ' ORDER BY l.run_id DESC, l.score DESC, l.id ASC';
  return db.prepare(sql).all(...params).map(hydrateLead);
}

function getLeadForUser(id, userId) {
  const row = getDb().prepare(
    `SELECT l.* FROM outbound_leads l
     JOIN outbound_runs r ON r.id = l.run_id
     WHERE l.id = ? AND r.created_by = ?`
  ).get(id, userId);
  return row ? hydrateLead(row) : null;
}

const LEAD_STATUSES = ['new', 'contacted', 'replied', 'skipped'];

// Patch status and/or notes for a lead the user owns. Returns the updated lead,
// or null if not found. Ignores unknown/invalid fields.
function updateLeadForUser(id, userId, { status, notes }) {
  const existing = getLeadForUser(id, userId);
  if (!existing) return null;
  const sets = [];
  const vals = [];
  if (status !== undefined && LEAD_STATUSES.includes(status)) { sets.push('status = ?'); vals.push(status); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(String(notes).slice(0, 2000)); }
  if (sets.length) {
    vals.push(id);
    getDb().prepare(`UPDATE outbound_leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return getLeadForUser(id, userId);
}

// Replace the generated draft (and optional channel) after a redraft.
function updateLeadDraft(id, { draft, channel, confidence }) {
  const sets = ['draft = ?'];
  const vals = [draft];
  if (channel) { sets.push('channel = ?'); vals.push(channel); }
  if (confidence) { sets.push('confidence = ?'); vals.push(confidence); }
  vals.push(id);
  getDb().prepare(`UPDATE outbound_leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function hydrateLead(row) {
  return { ...row, score_breakdown: parseJson(row.score_breakdown, {}) };
}

module.exports = {
  createRun, getRun, getRunForUser, listRunsForUser, updateRun,
  insertLead, listLeadsForRun, listLeadsForUser, getLeadForUser,
  updateLeadForUser, updateLeadDraft,
  LEAD_STATUSES,
};
