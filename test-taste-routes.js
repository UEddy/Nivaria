// Taste Gap routes: start a run, stream it, read it, list runs, run again.
//
//   node test-taste-routes.js
//
// Runs the real /api/taste router, run store and agent loop on a throwaway
// database, with the scripted model stand-in and the fake Qloo
// (scripts/qloo-fake.js), so it needs no keys and makes no network calls.
// Auth is stubbed to a fixed user; ownership is checked with a second one.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-routes-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.db');
process.env.LLM_CHAIN = 'scripted';
process.env.SCRIPTED_DELAY_MS = '150';
// This file runs many fresh runs from one IP; the limits have their own test
// (test-taste-cache.js).
process.env.TASTE_FRESH_PER_DAY = '100';
require('./scripts/qloo-fake');

const express = require('express');
const { initDb, getDb } = require('./src/db');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  ok   ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

function request(port, method, url, { body, user = ME } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path: url, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Reads an SSE stream to its end and returns the parsed events.
function stream(port, url, user = ME) {
  return new Promise((resolve, reject) => {
    http.get({ port, path: url, headers: { 'x-test-user': String(user) } }, res => {
      let buf = '';
      const events = [];
      res.on('data', c => {
        buf += c;
        let cut;
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const ev = /^event: (.*)$/m.exec(chunk);
          const data = /^data: (.*)$/m.exec(chunk);
          if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], events }));
    }).on('error', reject);
  });
}

// High ids, clear of the demo user a fresh database seeds.
const ME = 9001;
const OTHER = 9002;

async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 100));
  }
}

async function main() {
  await initDb();
  const db = getDb();
  for (const id of [ME, OTHER]) {
    db.prepare("INSERT INTO users (id, email, name, api_key) VALUES (?, ?, 'Test', ?)").run(id, 'u' + id + '@example.test', 'key' + id);
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = Number(req.headers['x-test-user']); next(); });
  const tasteRouter = require('./src/routes/taste');
  app.get('/api/taste/search', tasteRouter.search);
  app.use('/api/taste', tasteRouter);
  const server = app.listen(0);
  const port = server.address().port;

  console.log('search');
  const found = await request(port, 'GET', '/api/taste/search?q=glossier');
  check('search returns brand names', found.json?.results?.[0]?.name === 'Glossier', found.text);
  const short = await request(port, 'GET', '/api/taste/search?q=g');
  check('one character returns no suggestions', Array.isArray(short.json?.results) && short.json.results.length === 0, short.text);

  console.log('status and validation');
  const st = await request(port, 'GET', '/api/taste/status');
  check('status reports ready', st.json?.ready === true, st.text);
  const nobrandAtAll = await request(port, 'POST', '/api/taste/runs', { body: { brand: '', rivals: ['Glossier'] } });
  check('a run needs a brand', nobrandAtAll.status === 400, nobrandAtAll.text);
  const same = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Glossier', rivals: ['glossier'] } });
  check('a rival must differ from the brand', same.status === 400, same.text);
  const three = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'A', rivals: ['B', 'C', 'D'] } });
  check('at most two rivals', three.status === 400, three.text);

  console.log('start and stream');
  const started = await request(port, 'POST', '/api/taste/runs', {
    body: { brand: 'Glossier', rivals: ['Fenty Beauty'], city: 'New York' },
  });
  check('start returns 202 with a running run', started.status === 202 && started.json?.run?.status === 'running', started.text);
  const id = started.json.run.id;

  const busy = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Nike', rivals: ['Adidas'] } });
  check('a second run while one is going is refused', busy.status === 409 && busy.json?.id === id, busy.text);

  const live = await stream(port, '/api/taste/runs/' + id + '/events');
  check('events stream is text/event-stream', /text\/event-stream/.test(live.type || ''), live.type);
  const steps = live.events.filter(e => e.event === 'step').map(e => e.data);
  const end = live.events[live.events.length - 1];
  check('stream ends with end: done', end?.event === 'end' && end.data.status === 'done', JSON.stringify(end));
  check('stream carries running and finished steps', steps.some(s => s.status === 'running') && steps.some(s => s.status === 'done'));
  check('stream includes the geo_gap tool step', steps.some(s => s.tool === 'geo_gap'));

  console.log('read');
  const got = await request(port, 'GET', '/api/taste/runs/' + id);
  const run = got.json?.run;
  check('run is done with a brief', run?.status === 'done' && Boolean(run.brief?.headline), got.text.slice(0, 200));
  check('brief has segments with resolved evidence', run.brief.rival_owned_segments.length > 0
    && run.brief.rival_owned_segments.every(s => s.evidence.every(e => typeof e.gap === 'number')));
  check('chart data has map cells and demographics', Object.values(run.data.geo)[0]?.cells.length > 0
    && Object.values(run.data.demographics)[0]?.age.length === 6);
  // The fake search ranks a same-named state above the city, as Qloo does for New York.
  const scoped = run.steps.filter(s => s.input?.locality_id).map(s => s.input.locality_id);
  check('find_city picks the city over the state of the same name',
    Object.values(run.data.geo)[0]?.locality.locality_id === 'locality-new-york'
    && /not the state/.test(run.steps.find(s => s.tool === 'find_city')?.summary || '')
    && scoped.length >= 2 && new Set(scoped).size === 1, JSON.stringify(Object.values(run.data.geo)[0]?.locality));
  // Fake cells carry county names (New York County) that read as boroughs (Manhattan).
  check('hotspots are labelled neighborhood, borough', run.brief.geo_hotspots.length > 0
    && run.brief.geo_hotspots.every(h => h.label && !/County/.test(h.label))
    && run.brief.geo_hotspots.some(h => /^[^,]+, [^,]+$/.test(h.label)), JSON.stringify(run.brief.geo_hotspots.map(h => h.label)));
  const prov = run.brief.provenance || {};
  check('the brief says how many Qloo data points it cites and how many were dropped', prov.data_points > 0 && prov.dropped === 0, JSON.stringify(prov));
  check('and which Qloo endpoints fed it, with counts', ['search', 'insights', 'cross_scoring', 'heatmap', 'demographics', 'compare']
    .every(k => (prov.endpoints || []).some(e => e.key === k && e.calls > 0))
    && prov.qloo_calls === prov.endpoints.reduce((n, e) => n + e.calls, 0), JSON.stringify(prov.endpoints));
  check('and which model wrote it', prov.written_by?.provider === 'scripted' && prov.written_by.model === 'script', JSON.stringify(prov.written_by));
  check('every trace step names its Qloo endpoint in a sentence', run.steps.filter(s => s.kind === 'tool' && s.tool !== 'submit_brief')
    .every(s => /with Qloo (search|insights|heatmaps|demographics|compare)/.test(s.label))
    && /^Writing the brief with Scripted stand-in/.test(run.steps.find(s => s.tool === 'submit_brief')?.label || ''),
    run.steps.map(s => s.label).join(' | ').slice(0, 300));
  check('stored trace matches the streamed one', run.steps.length === new Set(steps.map(s => s.n)).size);
  check('model is the scripted stand-in', /^scripted:/.test(run.model || ''), run.model);
  check('no em or en dash in the brief', !/[\u2013\u2014]/.test(JSON.stringify(run.brief)));

  const replay = await stream(port, '/api/taste/runs/' + id + '/events');
  check('a finished run replays its trace and ends', replay.events.filter(e => e.event === 'step').length === run.steps.length
    && replay.events[replay.events.length - 1].data.status === 'done');

  console.log('ownership');
  const other = await request(port, 'GET', '/api/taste/runs/' + id, { user: OTHER });
  check('another user gets 404', other.status === 404);
  const otherStream = await request(port, 'GET', '/api/taste/runs/' + id + '/events', { user: OTHER });
  check('another user cannot stream it', otherStream.status === 404);
  const otherList = await request(port, 'GET', '/api/taste/runs', { user: OTHER });
  check("another user's list is empty", otherList.json?.runs?.length === 0);

  console.log('run again and list');
  const again = await request(port, 'POST', '/api/taste/runs/' + id + '/rerun');
  check('rerun starts a new run with the same inputs', again.status === 202 && again.json.run.rerun_of === id
    && again.json.run.brand === 'Glossier' && again.json.run.city === 'New York', again.text);
  const second = await waitFor(async () => {
    const r = await request(port, 'GET', '/api/taste/runs/' + again.json.run.id);
    return r.json.run.status !== 'running' && r.json.run;
  });
  check('rerun finishes', second.status === 'done', second.error_message);
  const list = await request(port, 'GET', '/api/taste/runs');
  check('list is newest first', list.json.runs.map(r => r.id).join() === [again.json.run.id, id].join());
  check('list rows carry no blobs', list.json.runs.every(r => !('brief' in r) && !('data' in r) && Array.isArray(r.rivals)));

  console.log('failure');
  // "Nike!" passes input checks but resolves to the same Qloo brand as "Nike".
  const nobrand = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Nike', rivals: ['Nike!'] } });
  check('a run that will fail still starts', nobrand.status === 202, nobrand.text);
  const failedRun = await waitFor(async () => {
    const r = await request(port, 'GET', '/api/taste/runs/' + nobrand.json.run.id);
    return r.json.run.status !== 'running' && r.json.run;
  });
  check('a failed run ends in error with a friendly message and its trace', failedRun.status === 'error'
    && /could not find two different brands/.test(failedRun.error_message) && !/Scripted|Qloo brand as ours/.test(failedRun.error_message)
    && failedRun.steps.length > 0, failedRun.status + ' ' + failedRun.error_message);

  console.log('rival discovery');
  const disc = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Starbucks', rivals: [], city: 'New York' } });
  check('a run with no rival starts (the agent finds them)', disc.status === 202 && disc.json?.run?.rivals?.length === 0, disc.text);
  const dRun = await waitFor(async () => {
    const r = await request(port, 'GET', '/api/taste/runs/' + disc.json.run.id);
    return r.json.run.status !== 'running' && r.json.run;
  });
  const rc = dRun.brief?.rival_choice;
  check('the discovery run finishes with a brief', dRun.status === 'done' && dRun.brief.rival_owned_segments.length > 0, dRun.status + ' ' + dRun.error_message);
  check('the run is stored under the rival the agent chose', dRun.rivals.length >= 1 && dRun.rivals.length <= 2
    && dRun.brief.rivals.map(r => r.name).join() === dRun.rivals.join(), JSON.stringify(dRun.rivals));
  check('the brief carries the decision: candidates, picks and a reason', rc && rc.candidates.length > 3
    && rc.candidates.filter(c => c.picked).map(c => c.name).join() === dRun.rivals.join() && /affinity/.test(rc.reason), JSON.stringify(rc && rc.reason));
  check('the same brand family and the retailer are flagged and not picked', rc.candidates.some(c => c.flags.includes('same brand family') && !c.picked)
    && rc.candidates.some(c => c.flags.includes('retailer') && !c.picked));
  check('our own brand is never a candidate', !rc.candidates.some(c => c.name === 'Starbucks'));
  check('the trace shows discovery and the choice', dRun.steps.some(s => s.tool === 'discover_rivals' && s.status === 'done')
    && dRun.steps.some(s => s.tool === 'choose_rivals' && s.status === 'done' && /affinity/.test(s.summary)));
  check('no em or en dash in the decision', !/[\u2013\u2014]/.test(JSON.stringify(rc)));
  const pairHit = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Starbucks', rivals: dRun.rivals, city: 'New York' } });
  check('asking for the chosen pair later is a cache hit', pairHit.json?.cached === true && pairHit.json.run.id === dRun.id, pairHit.text.slice(0, 200));
  const discAgain = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Starbucks', rivals: [], city: 'New York' } });
  check('a blank rival is never served from the cache', discAgain.status === 202 && !discAgain.json.cached, discAgain.text.slice(0, 200));
  await waitFor(async () => (await request(port, 'GET', '/api/taste/runs/' + discAgain.json.run.id)).json.run.status !== 'running');

  console.log('featured briefs');
  const runsMod = require('./src/tasteRuns');
  const featuredMod = require('./src/tasteFeatured');
  const logged = [];
  const origLog = console.log;
  console.log = (...m) => { logged.push(m.join(' ')); };
  await featuredMod.ensureFeatured();
  console.log = origLog;
  check('featured briefs are not generated at boot by the scripted stand-in alone', runsMod.exampleKeys().length === 0
    && logged.some(l => /only the scripted stand-in/.test(l)), logged.join(' | '));
  for (const p of [...featuredMod.FEATURED].reverse()) {
    await runsMod.runExample(p.key, { brand: p.brand, rivals: p.rivals, city: p.city });
  }
  const fList = await request(port, 'GET', '/api/taste/featured', { user: OTHER });
  const pairs = fList.json?.pairs || [];
  check('every featured pair is listed with its brief, Starbucks first', pairs.length === featuredMod.FEATURED.length
    && pairs.every(p => p.run && p.run.id) && pairs[0].featured && pairs[0].key === 'starbucks-dunkin-nyc', fList.text.slice(0, 200));
  check('the featured preview carries headline and win-first picks', Boolean(pairs[0].run.headline) && pairs[0].run.win_first.length > 0 && pairs[0].run.hotspots > 0);
  const glossier = pairs.find(p => p.key === 'glossier-fenty');
  check('a no-city featured brief has no hotspots', glossier.city === null && glossier.run.hotspots === 0);
  const exRun = await request(port, 'GET', '/api/taste/runs/' + pairs[0].run.id, { user: OTHER });
  check('any user can open a featured brief', exRun.status === 200 && exRun.json.run.example_key === 'starbucks-dunkin-nyc');
  check('a run read carries no visitor hash or cache keys', !('client_hash' in exRun.json.run) && !('cache_key' in exRun.json.run) && !('resolved_key' in exRun.json.run));
  const otherRuns = await request(port, 'GET', '/api/taste/runs', { user: OTHER });
  check("featured briefs stay out of a user's runs list", otherRuns.json.runs.length === 0);
  const exRerun = await request(port, 'POST', '/api/taste/runs/' + pairs[0].run.id + '/rerun', { user: OTHER });
  check('run fresh on a featured brief starts the user\'s own run', exRerun.status === 202 && exRerun.json.run.rerun_of === pairs[0].run.id
    && exRerun.json.run.example_key === null, exRerun.text);
  await waitFor(async () => (await request(port, 'GET', '/api/taste/runs/' + exRerun.json.run.id, { user: OTHER })).json.run.status !== 'running');
  const firstId = pairs[0].run.id;
  const regen = await runsMod.runExample('starbucks-dunkin-nyc', { brand: 'Starbucks', rivals: ["Dunkin' Donuts"], city: 'New York' });
  const after = (await request(port, 'GET', '/api/taste/featured')).json.pairs;
  check('regenerating a featured brief replaces the old row', Boolean(regen.id) && after[0].run.id === regen.id
    && (await request(port, 'GET', '/api/taste/runs/' + firstId)).status === 404);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
