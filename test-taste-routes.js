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
  const bad = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Glossier', rivals: [] } });
  check('a run needs a rival', bad.status === 400, bad.text);
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
  check('a failed run ends in error with a message and its trace', failedRun.status === 'error'
    && /same Qloo brand/.test(failedRun.error_message) && failedRun.steps.length > 0, failedRun.status + ' ' + failedRun.error_message);

  console.log('examples');
  const runsMod = require('./src/tasteRuns');
  const examplesMod = require('./src/tasteExamples');
  const logged = [];
  const origLog = console.log;
  console.log = (...m) => { logged.push(m.join(' ')); };
  await examplesMod.ensureExamples();
  console.log = origLog;
  check('examples are not generated by the scripted stand-in alone', runsMod.exampleKeys().length === 0
    && logged.some(l => /only the scripted stand-in/.test(l)), logged.join(' | '));
  for (const ex of [...examplesMod.EXAMPLES].reverse()) {
    await runsMod.runExample(ex.key, { brand: ex.brand, rivals: ex.rivals, city: ex.city });
  }
  const exList = await request(port, 'GET', '/api/taste/examples', { user: OTHER });
  const exs = exList.json?.examples || [];
  check('both examples are listed, featured first', exs.length === 2 && exs[0].featured && exs[0].example_key === 'starbucks-dunkin-nyc', exList.text.slice(0, 200));
  check('the featured preview carries headline and win-first picks', Boolean(exs[0].headline) && exs[0].win_first.length > 0 && exs[0].hotspots > 0);
  check('the no-city example has no hotspots', exs[1].city === null && exs[1].hotspots === 0);
  const exRun = await request(port, 'GET', '/api/taste/runs/' + exs[0].id, { user: OTHER });
  check('any user can open an example run', exRun.status === 200 && exRun.json.run.example_key === 'starbucks-dunkin-nyc');
  const otherRuns = await request(port, 'GET', '/api/taste/runs', { user: OTHER });
  check("examples stay out of a user's runs list", otherRuns.json.runs.length === 0);
  const exRerun = await request(port, 'POST', '/api/taste/runs/' + exs[0].id + '/rerun', { user: OTHER });
  check('run again on an example starts the user\'s own run', exRerun.status === 202 && exRerun.json.run.rerun_of === exs[0].id
    && exRerun.json.run.example_key === null, exRerun.text);
  await waitFor(async () => (await request(port, 'GET', '/api/taste/runs/' + exRerun.json.run.id, { user: OTHER })).json.run.status !== 'running');
  const firstId = exs[0].id;
  await runsMod.runExample('starbucks-dunkin-nyc', { brand: 'Starbucks', rivals: ["Dunkin'"], city: 'New York' });
  const after = (await request(port, 'GET', '/api/taste/examples')).json.examples;
  check('regenerating an example replaces the old row', after.length === 2 && after[0].id !== firstId
    && (await request(port, 'GET', '/api/taste/runs/' + firstId)).status === 404);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
