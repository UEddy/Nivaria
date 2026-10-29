// Taste Gap API router, mounted at /api/taste in server.js behind
// limits.api, requireAuth and csrfProtect. Runs belong to the user who
// started them; every lookup is scoped by req.userId.
//
//   GET    /status             whether this server can start a run
//   GET    /featured           the featured pairs, each with its brief or null
//   POST   /runs               start a run { brand, rivals: [1 or 2], city?, fresh? },
//                              or answer it from the brief cache
//   GET    /runs               the user's runs, newest first (no blobs)
//   GET    /runs/:id           one run: brief, chart data and trace
//   GET    /runs/:id/events    the live trace as server-sent events
//   POST   /runs/:id/rerun     start a fresh run with the same inputs
//   GET    /runs/:id/share     the caller's public link to a finished brief, or null
//   POST   /runs/:id/share     make that link (or return the active one)
//   DELETE /runs/:id/share     revoke it
//   POST   /runs/:id/send      post a summary and the link to the caller's Slack
//                              and Discord webhooks; { webhook } saves one first
//   GET    /search?q=          brand suggestions for the form (Qloo /search),
//                              exported as router.search and mounted ahead
//                              of this router with its own limiter
//
// Brief cache: a request for a pair that already has a good brief from the
// last 14 days (the user's own, or a featured one) gets it back at once, 200
// with cached: true, and no Qloo or model calls. { fresh: true } and rerun
// skip the cache.
//
// Fresh runs are limited per visitor IP, not per account, because every judge
// shares one demo account: one run going at a time per IP, and
// TASTE_FRESH_PER_DAY (default 3) fresh runs per IP in 24 hours, which admins
// (ADMIN_EMAILS) skip. Each run fans out a few dozen Qloo calls under the
// client's 10 per second spacing. A refusal is a friendly message plus a code
// (busy, daily_limit, unavailable) the page uses to point at the featured
// briefs.

const express = require('express');
const runs = require('../tasteRuns');
const featured = require('../tasteFeatured');
const { isAdminEmail } = require('../lib/adminEmails');
const shares = require('../tasteShares');
const userWebhooks = require('../lib/userWebhooks');
const webhooks = require('../webhooks');
const limits = require('../middleware/rateLimits');
const qloo = require('../qloo/client');
const { sanitizeCopy } = require('../lib/sanitizeText');

const router = express.Router();

// A comment line to keep proxies from closing an idle stream.
const HEARTBEAT_MS = 20 * 1000;

const SEARCH_MIN = 2;
const SEARCH_MAX = 80;
const SEARCH_TAKE = 6;

const MESSAGES = {
  unavailable: 'New briefs cannot be written on this server right now. The featured briefs open instantly.',
  busy: 'You already have a brief being written. It takes up to three minutes, and the featured briefs open instantly in the meantime.',
};

function dailyLimitMessage({ limit, resets_at }) {
  const resets = resets_at ? Date.parse(resets_at.replace(' ', 'T') + 'Z') : NaN;
  const hours = Number.isFinite(resets) ? Math.max(1, Math.ceil((resets - Date.now()) / 3600000)) : 24;
  return 'This network has used its ' + limit + ' fresh brief' + (limit === 1 ? '' : 's') + ' for today. '
    + 'The featured briefs open instantly, and a fresh brief is available again in about ' + hours + ' hour' + (hours === 1 ? '' : 's') + '.';
}

function start(req, res, input, rerunOf) {
  const problem = runs.configProblem();
  if (problem) {
    console.warn('[taste] run refused: ' + problem);
    return res.status(503).json({ error: MESSAGES.unavailable, code: 'unavailable' });
  }
  const hash = runs.clientHash(req.ip);
  const active = runs.activeRunForClient(hash);
  if (active) {
    return res.status(409).json({ error: MESSAGES.busy, code: 'busy', id: active.created_by === req.userId ? active.id : undefined });
  }
  if (!isAdminEmail(req.user?.email)) {
    const usage = runs.freshRunUsage(hash);
    if (usage.used >= usage.limit) {
      return res.status(429).json({ error: dailyLimitMessage(usage), code: 'daily_limit', limit: usage.limit, resets_at: usage.resets_at });
    }
  }
  const run = runs.startRun(req.userId, input, { rerunOf, clientHash: hash });
  res.status(202).json({ run });
}

router.get('/status', (req, res) => {
  const problem = runs.configProblem();
  res.json({ ready: !problem, problem });
});

router.get('/featured', (req, res) => {
  res.json({ pairs: featured.listFeatured() });
});

router.post('/runs', (req, res) => {
  const input = runs.normalizeInput(req.body || {});
  if (input.error) return res.status(400).json({ error: input.error });
  // With no rival named there is no pair to look up yet: the agent discovers
  // the rivals, and that brief is cached under the ones it chose.
  if (req.body?.fresh !== true && input.rivals.length) {
    const hit = runs.findCachedRun(input, req.userId);
    if (hit) return res.json({ run: hit, cached: true });
  }
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

// ── Sharing ───────────────────────────────────────────────────────────────────
// A public, read-only link to a finished brief (src/tasteShares.js). Any brief
// the caller can read can be shared, featured ones included; only the caller's
// own link is listed or revoked.

function finishedRun(req, res) {
  const run = runs.getRunForUser(req.params.id, req.userId);
  if (!run) { res.status(404).json({ error: 'Brief not found.' }); return null; }
  if (run.status !== 'done') { res.status(409).json({ error: 'Only a finished brief can be shared.' }); return null; }
  return run;
}

router.get('/runs/:id/share', (req, res) => {
  const run = finishedRun(req, res);
  if (run) res.json({ share: shares.getShare(run.id, shares.ownerOf(req)) });
});

router.post('/runs/:id/share', (req, res) => {
  const run = finishedRun(req, res);
  if (run) res.json({ share: shares.createShare(run.id, shares.ownerOf(req)) });
});

router.delete('/runs/:id/share', (req, res) => {
  const run = finishedRun(req, res);
  if (run) res.json({ revoked: shares.revokeShare(run.id, shares.ownerOf(req)) });
});

// Post the headline, the top three win-first picks with their Qloo numbers,
// and the share link (made now if needed) to every webhook the caller has
// saved. A webhook pasted on the brief page comes in as { webhook } and is
// saved first, exactly as the Profile, Integrations card would save it.
router.post('/runs/:id/send', limits.tasteSend, async (req, res) => {
  const run = finishedRun(req, res);
  if (!run) return;
  const sessionOnly = userWebhooks.keptInSession(req);

  const pasted = String(req.body?.webhook || '').trim();
  if (pasted) {
    const kind = userWebhooks.webhookKind(pasted);
    if (!kind || pasted.length > 500) {
      return res.status(400).json({ error: 'Paste a Slack webhook (https://hooks.slack.com/...) or a Discord webhook (https://discord.com/api/webhooks/...).', code: 'bad_webhook' });
    }
    userWebhooks.saveWebhooks(req, { [kind + '_webhook']: pasted });
  }

  const saved = userWebhooks.getWebhooks(req);
  const targets = [
    saved.slack_webhook && { kind: 'slack', label: 'Slack', send: () => webhooks.sendTasteBriefSlack(saved.slack_webhook, summary) },
    saved.discord_webhook && { kind: 'discord', label: 'Discord', send: () => webhooks.sendTasteBriefDiscord(saved.discord_webhook, summary) },
  ].filter(Boolean);
  if (!targets.length) {
    return res.status(409).json({ error: 'No Slack or Discord webhook is saved yet.', code: 'no_webhook', session_only: sessionOnly });
  }

  const share = shares.createShare(run.id, shares.ownerOf(req));
  const summary = shares.briefSummary(run, share.url);
  const results = await Promise.allSettled(targets.map(t => t.send()));
  const sent = targets.filter((t, i) => results[i].status === 'fulfilled').map(t => t.kind);
  const failed = targets.filter((t, i) => results[i].status === 'rejected');
  for (const t of failed) {
    const err = results[targets.indexOf(t)].reason;
    console.warn('[taste] send to ' + t.kind + ' failed for run ' + run.id + ': ' + (err?.response?.status || '') + ' ' + err?.message);
  }
  if (!sent.length) {
    return res.status(502).json({
      error: failed.map(t => t.label).join(' and ') + ' did not accept the message. Check the webhook in Profile, Integrations, and try again.',
      code: 'send_failed', share,
    });
  }
  res.json({ sent, failed: failed.map(t => t.kind), share });
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
