// Taste Gap: run persistence and the background runner behind /api/taste.
// It lives outside src/taste on purpose: modules there may not touch the
// database (test-taste-privacy.js checks their imports).
//
// startRun() inserts a taste_runs row and runs the agent in the background.
// While a run is going, its trace lives in memory (live, keyed by run id) and
// subscribe() hands every step to the SSE stream as it happens; the agent
// emits a step once when it starts and again when it finishes, under the same
// n, so listeners upsert by n. When the run ends, the brief, chart data and
// trace are written to the row in one update and the live entry is dropped a
// little later, so a stream that connects late still reads it from the row.
//
// Brief cache: a finished run with a good brief answers the same question
// again for CACHE_DAYS, with no Qloo or model calls (findCachedRun).
// Per-visitor limits: fresh runs are counted per visitor IP, not per account,
// because every judge shares one demo account (freshRunUsage,
// activeRunForClient). A failed run stores a friendly message; the raw error
// goes to the server log only.
//
// Privacy: the agent only ever receives the brand, rivals and city typed for
// this run (see the privacy note in src/taste/agent.js). The user id is used
// here, for ownership, and never passed to the agent. The visitor IP is
// stored only as a salted hash and never leaves the server.

const crypto = require('crypto');
const { ipKeyGenerator } = require('express-rate-limit');
const { getDb } = require('./db');
const { runTasteAgent, cleanInput } = require('./taste/agent');
const llm = require('./taste/llm');

// Keep a finished run's live entry briefly, for a stream that connects just
// as the run ends.
const LIVE_LINGER_MS = 60 * 1000;

const live = new Map();   // run id -> { steps: [], listeners: Set<fn>, ended: false }

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

// Columns for the Runs list: everything except the large JSON blobs.
const SUMMARY_COLS = 'id, created_by, created_at, finished_at, status, brand, rivals, city, rerun_of, headline, model, turns, duration_ms, error_message, example_key';

// Featured briefs (src/tasteFeatured.js) belong to no user.
const EXAMPLE_OWNER = 0;

// Server-side columns that never go to a client.
const PRIVATE_COLS = ['client_hash', 'cache_key', 'resolved_key'];

function hydrate(row, { full = false } = {}) {
  if (!row) return null;
  const out = { ...row, rivals: parseJson(row.rivals, []) };
  for (const k of PRIVATE_COLS) delete out[k];
  if (full) {
    out.brief = parseJson(row.brief, null);
    out.data = parseJson(row.data, null);
    out.warnings = parseJson(row.warnings, []);
    out.providers = parseJson(row.providers, []);
    const entry = live.get(row.id);
    out.steps = entry && !entry.ended ? entry.steps.filter(Boolean) : parseJson(row.steps, []);
  }
  return out;
}

// A user's own run, or a featured run, which every user may read.
function getRunForUser(id, userId) {
  return hydrate(getDb().prepare(
    'SELECT * FROM taste_runs WHERE id = ? AND (created_by = ? OR example_key IS NOT NULL)'
  ).get(id, userId), { full: true });
}

function listRunsForUser(userId, limit = 50) {
  return getDb()
    .prepare(`SELECT ${SUMMARY_COLS} FROM taste_runs WHERE created_by = ? ORDER BY id DESC LIMIT ?`)
    .all(userId, limit)
    .map(r => hydrate(r));
}

// The run's inputs, cleaned the way the agent will clean them, so the row
// shows what was actually sent. Returns { error } when they cannot run.
function normalizeInput({ brand, rivals, city } = {}) {
  const b = cleanInput(brand);
  const list = (Array.isArray(rivals) ? rivals : [rivals]).map(cleanInput).filter(Boolean);
  if (!b) return { error: 'Enter your brand.' };
  if (!list.length) return { error: 'Enter at least one rival.' };
  if (list.length > 2) return { error: 'Compare against one or two rivals.' };
  if (list.some(r => r.toLowerCase() === b.toLowerCase())) return { error: 'A rival must be a different brand from yours.' };
  return { brand: b, rivals: list, city: cleanInput(city) || null };
}

// Why a run cannot start on this server right now, or null when it can.
function configProblem() {
  if (!String(process.env.QLOO_API_KEY || '').trim()) return 'Qloo is not configured on this server (QLOO_API_KEY).';
  try { llm.buildChain(); } catch (err) { return err.message; }
  return null;
}

// True when the only configured model is the scripted stand-in (dev and
// tests). Its templated briefs are served from the cache only then.
function scriptedOnly() {
  try {
    return llm.buildChain().every(e => e.name === 'scripted');
  } catch (_) {
    return false;
  }
}

// ── Brief cache ───────────────────────────────────────────────────────────────
// The same brand, rivals and city, normalized: case, accents, apostrophes and
// punctuation are ignored, rivals match in any order, "+" reads as "plus", a
// city is read up to its first comma, and a few common short forms ("NYC",
// "Dunkin") are mapped. Every run with a good brief carries two keys: the
// names as typed, and the names Qloo resolved them to, so "Dunkin'" and
// "Dunkin' Donuts" find each other. Only the asker's own runs and the
// featured briefs are served, so one account never learns which brands
// another account looked up.

const CACHE_DAYS = 14;

const NAME_ALIASES = {
  dunkin: 'dunkin donuts',
  coke: 'coca cola',
  'ulta beauty': 'ulta',
  'lululemon athletica': 'lululemon',
  'chipotle mexican grill': 'chipotle',
};
const CITY_ALIASES = {
  nyc: 'new york',
  'new york city': 'new york',
  'new york ny': 'new york',
  la: 'los angeles',
  sf: 'san francisco',
};

function baseName(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['\u2019`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const normName = s => { const n = baseName(s); return NAME_ALIASES[n] || n; };
const normCity = s => { const n = baseName(String(s || '').split(',')[0]); return CITY_ALIASES[n] || n; };

function cacheKey(brand, rivals, city) {
  return [normName(brand), (rivals || []).map(normName).sort().join(' / '), normCity(city)].join(' | ');
}

// Good enough to serve again: a headline, at least one segment and one
// win-first pick, and the map when a city was asked for.
function isGoodBrief(brief, data, city) {
  if (!brief || !brief.headline) return false;
  if (!(brief.rival_owned_segments || []).length || !(brief.win_first || []).length) return false;
  if (city && !Object.keys(data?.geo || {}).length) return false;
  return true;
}

function cacheKeysFor(input, brief, data) {
  if (!isGoodBrief(brief, data, input.city)) return { cache_key: null, resolved_key: null };
  const resolvedRivals = (brief.rivals || []).map(r => r.name).filter(Boolean);
  return {
    cache_key: cacheKey(input.brand, input.rivals, input.city),
    resolved_key: cacheKey(brief.brand?.name || input.brand,
      resolvedRivals.length === input.rivals.length ? resolvedRivals : input.rivals, input.city),
  };
}

// The newest good brief for this pair from the last CACHE_DAYS that this user
// may read, or null.
function findCachedRun(input, userId) {
  const key = cacheKey(input.brand, input.rivals, input.city);
  const row = getDb().prepare(`SELECT ${SUMMARY_COLS} FROM taste_runs
    WHERE (cache_key = ? OR resolved_key = ?) AND status = 'done'
      AND finished_at >= datetime('now', ?)
      AND (created_by = ? OR example_key IS NOT NULL)
      AND (? = 1 OR model IS NULL OR model NOT LIKE 'scripted%')
    ORDER BY finished_at DESC, id DESC LIMIT 1`)
    .get(key, key, '-' + CACHE_DAYS + ' days', userId, scriptedOnly() ? 1 : 0);
  return hydrate(row);
}

// ── Per-visitor limits ────────────────────────────────────────────────────────
// FRESH_PER_DAY fresh runs per visitor IP in any 24 hours, and one run going
// at a time. A cache hit is not a run and costs nothing. IPv6 addresses are
// grouped by /56 (as express-rate-limit does), so rotating the low bits does
// not reset the count.

const freshPerDay = () => Math.max(1, parseInt(process.env.TASTE_FRESH_PER_DAY, 10) || 3);

function clientHash(ip) {
  const salt = process.env.SESSION_SECRET || 'nivaria-dev';
  const key = ip ? ipKeyGenerator(String(ip)) : 'unknown';
  return crypto.createHash('sha256').update(salt + '|' + key).digest('hex').slice(0, 32);
}

function activeRunForClient(hash) {
  return getDb().prepare("SELECT id, created_by FROM taste_runs WHERE client_hash = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(hash) || null;
}

// { used, limit, resets_at }: resets_at is when the oldest counted run ages out.
function freshRunUsage(hash) {
  const row = getDb().prepare(
    "SELECT COUNT(*) AS used, datetime(MIN(created_at), '+1 day') AS resets_at FROM taste_runs WHERE client_hash = ? AND created_at >= datetime('now', '-1 day')"
  ).get(hash);
  return { used: Number(row?.used || 0), limit: freshPerDay(), resets_at: row?.used ? row.resets_at : null };
}

// ── Failure messages ──────────────────────────────────────────────────────────
// What a visitor sees when a run fails. Each one points at the featured
// briefs, which always load. The raw error goes to the server log.

const FRIENDLY = {
  timeout: 'This brief took longer than three minutes, so the run was stopped. The featured briefs open instantly, or try again in a few minutes.',
  busy: 'Every AI model we use is busy or out of quota right now, so this brief could not be written. The featured briefs open instantly, or try again later.',
  brand: 'Qloo could not find two different brands for those names. Check the spelling, or open one of the featured briefs.',
  generic: 'Something went wrong while writing this brief. The featured briefs open instantly, or try again later.',
  restarted: 'The server restarted while this brief was being written. Run it again, or open one of the featured briefs.',
};
const FRIENDLY_SET = new Set(Object.values(FRIENDLY));

// An error object, or a stored raw message, to the friendly message.
function friendlyError(err) {
  const msg = String(err?.message ?? err ?? '');
  if (FRIENDLY_SET.has(msg)) return msg;
  if (err?.timedOut || /ran out of time|timed out|timeout/i.test(msg)) return FRIENDLY.timeout;
  if (err?.chainExhausted || /\b429\b|quota|rate limit|\b50\d\b|overloaded|unavailable/i.test(msg)) return FRIENDLY.busy;
  if (/server restarted/i.test(msg)) return FRIENDLY.restarted;
  if (/brand/i.test(msg)) return FRIENDLY.brand;
  return FRIENDLY.generic;
}

// ── Running ───────────────────────────────────────────────────────────────────

function emit(entry, event) {
  for (const fn of entry.listeners) { try { fn(event); } catch (_) {} }
}

function finish(id, fields, entry) {
  const sets = Object.keys(fields).map(k => k + ' = ?');
  getDb().prepare(`UPDATE taste_runs SET ${sets.join(', ')}, finished_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...Object.values(fields), id);
  entry.ended = true;
  emit(entry, { type: 'end', status: fields.status, error: fields.error_message || null });
  entry.listeners.clear();
  setTimeout(() => live.delete(id), LIVE_LINGER_MS).unref?.();
}

// Run the agent for a row. Returns { ok, error } (error is the raw one).
async function execute(id, input, { chain = null } = {}) {
  const entry = live.get(id);
  try {
    const run = await runTasteAgent({
      brand: input.brand,
      rivals: input.rivals,
      city: input.city,
      chain,
      onStep: step => {
        entry.steps[step.n - 1] = step;
        emit(entry, { type: 'step', step });
      },
    });
    finish(id, {
      status: 'done',
      headline: run.brief.headline || null,
      brief: JSON.stringify(run.brief),
      data: JSON.stringify(run.data),
      steps: JSON.stringify(run.steps),
      warnings: JSON.stringify(run.warnings),
      providers: JSON.stringify(run.providers),
      model: run.model,
      turns: run.turns,
      duration_ms: run.duration_ms,
      ...cacheKeysFor(input, run.brief, run.data),
    }, entry);
    return { ok: true, error: null };
  } catch (err) {
    console.warn('[taste] run ' + id + ' failed: ' + err.message);
    const providers = err.providers || [];
    finish(id, {
      status: 'error',
      error_message: friendlyError(err),
      steps: JSON.stringify(err.steps || entry.steps.filter(Boolean)),
      providers: JSON.stringify(providers),
      model: providers.map(p => p.provider + ':' + p.model).join(' then ') || null,
    }, entry);
    return { ok: false, error: err };
  }
}

function insertRun(ownerId, input, rerunOf, hash) {
  const { lastInsertRowid: id } = getDb().prepare(
    "INSERT INTO taste_runs (created_by, status, brand, rivals, city, rerun_of, client_hash) VALUES (?, 'running', ?, ?, ?, ?, ?)"
  ).run(ownerId, input.brand, JSON.stringify(input.rivals), input.city, rerunOf, hash);
  live.set(id, { steps: [], listeners: new Set(), ended: false });
  return id;
}

// Insert the row and start the agent in the background. Returns the new row.
function startRun(userId, input, { rerunOf = null, clientHash: hash = null } = {}) {
  const id = insertRun(userId, input, rerunOf, hash);
  execute(id, input);
  return hydrate(getDb().prepare(`SELECT ${SUMMARY_COLS} FROM taste_runs WHERE id = ?`).get(id));
}

// ── Featured briefs ───────────────────────────────────────────────────────────

// Generate one featured brief and wait for it. On success it takes over key
// from any older brief (version marks one written by the featured script); a
// failed attempt is deleted so a later try starts clean. chain picks the
// models for this run only. Returns { id, error }: id null on failure.
async function runExample(key, input, { chain = null, version = null } = {}) {
  const id = insertRun(EXAMPLE_OWNER, input, null, null);
  const { ok, error } = await execute(id, input, { chain });
  const db = getDb();
  if (!ok) {
    db.prepare('DELETE FROM taste_runs WHERE id = ?').run(id);
    return { id: null, error };
  }
  db.savepoint(() => {
    db.prepare('DELETE FROM taste_runs WHERE example_key = ? AND id != ?').run(key, id);
    db.prepare('UPDATE taste_runs SET example_key = ?, example_version = ? WHERE id = ?').run(key, version, id);
  });
  return { id, error: null };
}

// Every finished featured brief, with the parts of the brief a preview needs.
function featuredRows() {
  return getDb()
    .prepare("SELECT id, example_key, example_version, finished_at, brand, rivals, city, model, brief, data FROM taste_runs WHERE example_key IS NOT NULL AND status = 'done' ORDER BY id")
    .all()
    .map(r => {
      const brief = parseJson(r.brief, {}) || {};
      return {
        id: r.id,
        example_key: r.example_key,
        example_version: r.example_version,
        finished_at: r.finished_at,
        brand: r.brand,
        rivals: parseJson(r.rivals, []),
        city: r.city,
        model: r.model,
        good: isGoodBrief(brief, parseJson(r.data, {}), r.city),
        headline: brief.headline || '',
        summary: brief.summary || '',
        win_first: (brief.win_first || []).slice(0, 3).map(w => ({ rank: w.rank, segment: w.segment, campaign_hook: w.campaign_hook })),
        segments: (brief.rival_owned_segments || []).length,
        hotspots: (brief.geo_hotspots || []).length,
      };
    });
}

function exampleKeys() {
  return getDb().prepare("SELECT example_key FROM taste_runs WHERE example_key IS NOT NULL AND status = 'done'").all().map(r => r.example_key);
}

// ── Live runs ─────────────────────────────────────────────────────────────────

// Listen to a live run. Returns an unsubscribe function, or null when the run
// is not live (finished, or from before a restart): read the row instead.
function subscribe(id, fn) {
  const entry = live.get(Number(id));
  if (!entry || entry.ended) return null;
  entry.listeners.add(fn);
  return () => entry.listeners.delete(fn);
}

function liveSteps(id) {
  const entry = live.get(Number(id));
  return entry ? entry.steps.filter(Boolean) : null;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

// A restart loses the background work, so a row still marked running at boot
// can never finish. Close it out instead of leaving the UI waiting.
function closeInterruptedRuns() {
  // A featured attempt cut off by the restart is retried later, so drop it
  // instead of keeping a failed row.
  getDb().prepare("DELETE FROM taste_runs WHERE created_by = ? AND example_key IS NULL AND status = 'running'").run(EXAMPLE_OWNER);
  getDb().prepare(
    "UPDATE taste_runs SET status = 'error', error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE status = 'running'"
  ).run(FRIENDLY.restarted);
}

// Rows stored before this code: failed runs get the friendly message in place
// of a raw error, and good briefs from the cache window get their cache keys.
function tidyStoredRuns() {
  const db = getDb();
  db.savepoint(() => {
    for (const r of db.prepare("SELECT id, error_message FROM taste_runs WHERE status = 'error'").all()) {
      const friendly = friendlyError(r.error_message);
      if (friendly !== r.error_message) db.prepare('UPDATE taste_runs SET error_message = ? WHERE id = ?').run(friendly, r.id);
    }
    const stale = db.prepare(
      "SELECT id, brand, rivals, city, brief, data FROM taste_runs WHERE status = 'done' AND cache_key IS NULL AND finished_at >= datetime('now', ?)"
    ).all('-' + CACHE_DAYS + ' days');
    for (const r of stale) {
      const keys = cacheKeysFor({ brand: r.brand, rivals: parseJson(r.rivals, []), city: r.city }, parseJson(r.brief, null), parseJson(r.data, null));
      if (keys.cache_key) db.prepare('UPDATE taste_runs SET cache_key = ?, resolved_key = ? WHERE id = ?').run(keys.cache_key, keys.resolved_key, r.id);
    }
  });
}

module.exports = {
  startRun, getRunForUser, listRunsForUser, normalizeInput, configProblem,
  findCachedRun, cacheKey, isGoodBrief, CACHE_DAYS,
  clientHash, activeRunForClient, freshRunUsage, freshPerDay,
  friendlyError, FRIENDLY,
  runExample, featuredRows, exampleKeys, EXAMPLE_OWNER,
  subscribe, liveSteps, closeInterruptedRuns, tidyStoredRuns,
};
