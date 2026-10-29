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
// Privacy: the agent only ever receives the brand, rivals and city typed for
// this run (see the privacy note in src/taste/agent.js). The user id is used
// here, for ownership, and never passed to the agent.

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
const SUMMARY_COLS = 'id, created_at, finished_at, status, brand, rivals, city, rerun_of, headline, model, turns, duration_ms, error_message';

function hydrate(row, { full = false } = {}) {
  if (!row) return null;
  const out = { ...row, rivals: parseJson(row.rivals, []) };
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

function getRunForUser(id, userId) {
  return hydrate(getDb().prepare('SELECT * FROM taste_runs WHERE id = ? AND created_by = ?').get(id, userId), { full: true });
}

function listRunsForUser(userId, limit = 50) {
  return getDb()
    .prepare(`SELECT ${SUMMARY_COLS} FROM taste_runs WHERE created_by = ? ORDER BY id DESC LIMIT ?`)
    .all(userId, limit)
    .map(r => hydrate(r));
}

function activeRunForUser(userId) {
  return getDb().prepare("SELECT id FROM taste_runs WHERE created_by = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(userId) || null;
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

async function execute(id, input) {
  const entry = live.get(id);
  try {
    const run = await runTasteAgent({
      ...input,
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
    }, entry);
  } catch (err) {
    console.warn('[taste] run ' + id + ' failed: ' + err.message);
    const providers = err.providers || [];
    finish(id, {
      status: 'error',
      error_message: String(err.message || 'The run failed').slice(0, 500),
      steps: JSON.stringify(err.steps || entry.steps.filter(Boolean)),
      providers: JSON.stringify(providers),
      model: providers.map(p => p.provider + ':' + p.model).join(' then ') || null,
    }, entry);
  }
}

// Insert the row and start the agent in the background. Returns the new row.
function startRun(userId, input, { rerunOf = null } = {}) {
  const { lastInsertRowid: id } = getDb().prepare(
    "INSERT INTO taste_runs (created_by, status, brand, rivals, city, rerun_of) VALUES (?, 'running', ?, ?, ?, ?)"
  ).run(userId, input.brand, JSON.stringify(input.rivals), input.city, rerunOf);
  live.set(id, { steps: [], listeners: new Set(), ended: false });
  execute(id, { brand: input.brand, rivals: input.rivals, city: input.city });
  return hydrate(getDb().prepare(`SELECT ${SUMMARY_COLS} FROM taste_runs WHERE id = ?`).get(id));
}

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

// A restart loses the background work, so a row still marked running at boot
// can never finish. Close it out instead of leaving the UI waiting.
function closeInterruptedRuns() {
  getDb().prepare(
    "UPDATE taste_runs SET status = 'error', error_message = 'The server restarted during this run. Run it again.', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'"
  ).run();
}

module.exports = {
  startRun, getRunForUser, listRunsForUser, activeRunForUser, normalizeInput, configProblem,
  subscribe, liveSteps, closeInterruptedRuns,
};
