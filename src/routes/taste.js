// Taste Gap API router, mounted at /api/taste in server.js behind
// limits.api, requireAuth and csrfProtect. Runs belong to the user who
// started them; every lookup is scoped by req.userId.
//
//   GET    /status             whether this server can start a run
//   POST   /runs               start a run { brand, rivals: [1 or 2], city? }
//   GET    /runs               the user's runs, newest first (no blobs)
//   GET    /runs/:id           one run: brief, chart data and trace
//   GET    /runs/:id/events    the live trace as server-sent events
//   POST   /runs/:id/rerun     start a new run with the same inputs
//   GET    /search?q=          brand suggestions for the form (Qloo /search),
//                              exported as router.search and mounted ahead
//                              of this router with its own limiter
//
// A user has at most one run going at a time: each run fans out a few dozen
// Qloo calls under a 10 per second cap, and a second run would only queue
// behind the first.

const express = require('express');
const runs = require('../tasteRuns');
const qloo = require('../qloo/client');
const { sanitizeCopy } = require('../lib/sanitizeText');

const router = express.Router();

// A comment line to keep proxies from closing an idle stream.
const HEARTBEAT_MS = 20 * 1000;

const SEARCH_MIN = 2;
const SEARCH_MAX = 80;
const SEARCH_TAKE = 6;

function start(req, res, input, rerunOf) {
  const problem = runs.configProblem();
  if (problem) return res.status(503).json({ error: problem });
  const active = runs.activeRunForUser(req.userId);
  if (active) return res.status(409).json({ error: 'A run is already going. Wait for it to finish.', id: active.id });
  const run = runs.startRun(req.userId, input, { rerunOf });
  res.status(202).json({ run });
}

router.get('/status', (req, res) => {
  const problem = runs.configProblem();
  res.json({ ready: !problem, problem });
});

router.post('/runs', (req, res) => {
  const input = runs.normalizeInput(req.body || {});
  if (input.error) return res.status(400).json({ error: input.error });
  start(req, res, input, null);
});

router.get('/runs', (req, res) => {
  res.json({ runs: runs.listRunsForUser(req.userId) });
});

router.get('/runs/:id', (req, res) => {
  const run = runs.getRunForUser(req.params.id, req.userId);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  res.json({ run });
});

router.post('/runs/:id/rerun', (req, res) => {
  const prev = runs.getRunForUser(req.params.id, req.userId);
  if (!prev) return res.status(404).json({ error: 'Run not found.' });
  const input = runs.normalizeInput({ brand: prev.brand, rivals: prev.rivals, city: prev.city });
  if (input.error) return res.status(400).json({ error: input.error });
  start(req, res, input, prev.id);
});

// Events: "step" carries one trace step (upsert by step.n), "end" carries the
// final status. A finished run replays its stored trace and ends at once.
router.get('/runs/:id/events', (req, res) => {
  const run = runs.getRunForUser(req.params.id, req.userId);
  if (!run) return res.status(404).json({ error: 'Run not found.' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');

  // Subscribe before replaying, so a step that lands in between is not lost
  // (the client upserts by n, so a repeat is harmless).
  let ended = false;
  let heartbeat = null;
  const close = () => {
    clearInterval(heartbeat);
    if (!ended) { ended = true; res.end(); }
  };
  const unsubscribe = run.status === 'running'
    ? runs.subscribe(run.id, event => {
      if (event.type === 'step') send('step', event.step);
      else { send('end', { status: event.status, error: event.error }); close(); }
    })
    : null;

  for (const step of runs.liveSteps(run.id) || run.steps || []) send('step', step);

  if (!unsubscribe) {
    // Not live: finished, or the row is stale. Read the row again in case the
    // run ended between the first read and now.
    const now = runs.getRunForUser(run.id, req.userId);
    send('end', { status: now.status, error: now.error_message || null });
    return close();
  }

  heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); ended = true; });
});

// Brand suggestions as the user types. Names only, plus a short description
// so two brands with one name can be told apart. Qloo answers repeat queries
// from the client's cache, and a failure returns no suggestions rather than an
// error: the form works without them.
router.search = async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, SEARCH_MAX);
  if (q.length < SEARCH_MIN || !String(process.env.QLOO_API_KEY || '').trim()) return res.json({ results: [] });
  try {
    const d = await qloo.search(q, { types: 'urn:entity:brand', take: SEARCH_TAKE });
    const seen = new Set();
    const results = [];
    for (const e of d?.results || []) {
      const name = String(e.name || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const desc = String(e.properties?.short_description || '').trim();
      results.push({ name, description: desc ? sanitizeCopy(desc.length > 90 ? desc.slice(0, 87) + '...' : desc) : null });
    }
    res.json({ results });
  } catch (err) {
    console.warn('[taste] search failed: ' + err.message);
    res.json({ results: [] });
  }
};

module.exports = router;
