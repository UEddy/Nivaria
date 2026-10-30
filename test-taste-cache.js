// Taste Gap brief cache, per-visitor limits, friendly failures, and the
// featured-brief script.
//
//   node test-taste-cache.js
//
// Runs the real /api/taste router, the internal featured routes, the run
// store and the agent loop on a throwaway database, with the scripted model
// stand-in and the fake Qloo (scripts/qloo-fake.js), so it needs no keys and
// makes no network calls beyond localhost. Visitors are told apart by
// X-Forwarded-For (the app trusts it here, as the server trusts Caddy).

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-cache-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.db');
process.env.LLM_CHAIN = 'scripted';
process.env.FEATURED_CHAIN = 'scripted';
process.env.SCRIPTED_DELAY_MS = '30';
process.env.TASTE_FRESH_PER_DAY = '3';
process.env.ADMIN_EMAILS = 'admin@example.test';
delete process.env.SCRIPTED_QUOTA_AFTER;
delete process.env.TASTE_EXAMPLES;
require('./scripts/qloo-fake');

const express = require('express');
const { initDb, getDb } = require('./src/db');
const client = require('./src/qloo/client');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  ok   ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

// Every Qloo call the tools make, through the fake.
let qlooCalls = 0;
for (const k of ['search', 'insights', 'compare']) {
  const fn = client[k];
  client[k] = (...a) => { qlooCalls += 1; return fn(...a); };
}
// "Fenty" resolves to Qloo's "Fenty Beauty", so a run typed one way carries
// the other as its resolved key.
const search = client.search;
client.search = (q, opts) => search(q, opts).then(d => (String(q).toLowerCase() === 'fenty'
  ? { results: d.results.map(e => ({ ...e, name: 'Fenty Beauty' })) } : d));

const ME = 9101;
const OTHER = 9102;

function request(port, method, url, { body, user = ME, ip = '198.51.100.1', email, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json', 'x-test-user': String(user), ...headers };
    if (ip) h['x-forwarded-for'] = ip;
    if (email) h['x-test-email'] = email;
    const started = Date.now();
    const req = http.request({ port, method, path: url, headers: h }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, text, json, ms: Date.now() - started });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(fn, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 50));
  }
}

const RAW = /Scripted|stand-in|\(429\)|status|Error:|undefined/;

async function main() {
  await initDb();
  const db = getDb();
  for (const id of [ME, OTHER]) {
    db.prepare("INSERT INTO users (id, email, name, api_key) VALUES (?, ?, 'Test', ?)").run(id, 'u' + id + '@example.test', 'key' + id);
  }
  const runs = require('./src/tasteRuns');
  const featured = require('./src/tasteFeatured');

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = Number(req.headers['x-test-user']);
    req.user = { id: req.userId, email: req.headers['x-test-email'] || 'u' + req.userId + '@example.test' };
    next();
  });
  app.use('/internal/taste', require('./src/routes/tasteInternal'));
  app.use('/api/taste', require('./src/routes/taste'));
  const server = app.listen(0);
  const port = server.address().port;

  const runCount = () => db.prepare('SELECT COUNT(*) AS n FROM taste_runs').get().n;
  const finish = async (res, user = ME) => waitFor(async () => {
    const r = await request(port, 'GET', '/api/taste/runs/' + res.json.run.id, { user });
    return r.json.run.status !== 'running' && r.json.run;
  });

  // ── Brief cache ─────────────────────────────────────────────────────────────
  console.log('brief cache');
  const first = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Glossier', rivals: ['Fenty'], city: 'New York' }, ip: '198.51.100.10' });
  check('a new pair starts a fresh run', first.status === 202 && !first.json.cached, first.text);
  const done = await finish(first);
  check('the fresh run finishes with a good brief', done.status === 'done' && Boolean(done.brief?.headline));

  const rowsBefore = runCount();
  const callsBefore = qlooCalls;
  const hit = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'glossier', rivals: ['FENTY'], city: 'New York City' }, ip: '198.51.100.11' });
  check('the same pair (other case, city alias) comes back from the cache', hit.status === 200 && hit.json.cached === true && hit.json.run.id === done.id, hit.text);
  check('a cache hit makes no Qloo or model calls', qlooCalls === callsBefore && runCount() === rowsBefore, (qlooCalls - callsBefore) + ' calls');
  check('a cache hit answers at once', hit.ms < 500, hit.ms + 'ms');
  check('a cache hit carries the finished brief summary', hit.json.run.status === 'done' && Boolean(hit.json.run.headline) && Boolean(hit.json.run.finished_at));

  const resolved = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Glossier', rivals: ['Fenty Beauty'], city: 'new york, ny' }, ip: '198.51.100.11' });
  check("the pair under Qloo's resolved name hits too", resolved.status === 200 && resolved.json.run.id === done.id, resolved.text);
  const twoRivals = runs.cacheKey('A', ['Rare Beauty', "Fenty Beauty"], null) === runs.cacheKey('a', ['fenty beauty', 'Rare Beauty'], '');
  check('rivals match in any order, and a blank city is no city', twoRivals);
  check("apostrophes, '+' and accents are ignored", runs.cacheKey("Dunkin'", ['Disney+'], null) === runs.cacheKey('Dunkin', ['Disney Plus'], null)
    && runs.cacheKey('Café X', ['Y'], null) === runs.cacheKey('Cafe X', ['Y'], null));
  check('another city is a different pair', !runs.findCachedRun({ brand: 'Glossier', rivals: ['Fenty'], city: 'Chicago' }, ME));
  check("another account's run is never served", !runs.findCachedRun({ brand: 'Glossier', rivals: ['Fenty'], city: 'New York' }, OTHER));

  const fresh = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Glossier', rivals: ['Fenty'], city: 'New York', fresh: true }, ip: '198.51.100.12' });
  check('fresh: true skips the cache', fresh.status === 202 && !fresh.json.cached, fresh.text);
  const freshDone = await finish(fresh);
  const newest = runs.findCachedRun({ brand: 'Glossier', rivals: ['Fenty'], city: 'New York' }, ME);
  check('the newest good brief is the one served', newest?.id === freshDone.id);

  db.prepare("UPDATE taste_runs SET finished_at = datetime('now', '-15 days') WHERE cache_key IS NOT NULL").run();
  check('a brief older than 14 days is not served', !runs.findCachedRun({ brand: 'Glossier', rivals: ['Fenty'], city: 'New York' }, ME));
  db.prepare("UPDATE taste_runs SET finished_at = datetime('now', '-13 days') WHERE cache_key IS NOT NULL").run();
  check('one from 13 days ago is', Boolean(runs.findCachedRun({ brand: 'Glossier', rivals: ['Fenty'], city: 'New York' }, ME)));

  check('a brief with no segments, or no map for a city, is not good enough', !runs.isGoodBrief({ headline: 'x', rival_owned_segments: [], win_first: [{}] }, {}, null)
    && !runs.isGoodBrief({ headline: 'x', rival_owned_segments: [{}], win_first: [{}] }, { geo: {} }, 'Austin')
    && runs.isGoodBrief({ headline: 'x', rival_owned_segments: [{}], win_first: [{}] }, { geo: {} }, null));

  // A run that failed is never served.
  const bad = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Nike', rivals: ['Nike!'] }, ip: '198.51.100.13' });
  await finish(bad);
  check('a failed run is not served from the cache', !runs.findCachedRun({ brand: 'Nike', rivals: ['Nike!'], city: null }, ME));

  // ── Per-visitor limits ──────────────────────────────────────────────────────
  console.log('per-visitor limits');
  const A = '203.0.113.1';
  for (let i = 1; i <= 3; i += 1) {
    const r = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand' + i, rivals: ['Rival' + i] }, ip: A });
    if (r.status !== 202) check('fresh run ' + i + ' from one IP is allowed', false, r.text);
    await finish(r);
  }
  const fourth = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand4', rivals: ['Rival4'] }, ip: A });
  check('a fourth fresh run from the same IP in a day is refused', fourth.status === 429 && fourth.json.code === 'daily_limit', fourth.text);
  check('the refusal is friendly and points at the featured briefs', /featured briefs open instantly/.test(fourth.json.error)
    && /about \d+ hours?/.test(fourth.json.error) && !RAW.test(fourth.json.error), fourth.json.error);
  const sameAccountOtherIp = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand5', rivals: ['Rival5'] }, ip: '203.0.113.2' });
  check('the same account from another IP still runs (judges share one account)', sameAccountOtherIp.status === 202, sameAccountOtherIp.text);
  await finish(sameAccountOtherIp);
  const cachedAtLimit = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand1', rivals: ['Rival1'] }, ip: A });
  check('a limited IP still gets cached briefs', cachedAtLimit.status === 200 && cachedAtLimit.json.cached === true, cachedAtLimit.text);
  const rerunAtLimit = await request(port, 'POST', '/api/taste/runs/' + cachedAtLimit.json.run.id + '/rerun', { ip: A });
  check('run fresh respects the daily limit', rerunAtLimit.status === 429 && rerunAtLimit.json.code === 'daily_limit', rerunAtLimit.text);
  const admin = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand6', rivals: ['Rival6'] }, ip: A, email: 'admin@example.test' });
  check('an admin skips the daily limit', admin.status === 202, admin.text);
  await finish(admin);

  // Slow the stand-in so the first run is still going when the second arrives.
  process.env.SCRIPTED_DELAY_MS = '400';
  const C = '203.0.113.3';
  const c1 = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand7', rivals: ['Rival7'] }, ip: C });
  const c2 = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand8', rivals: ['Rival8'] }, ip: C });
  check('a second run from the same IP while one is going is refused', c1.status === 202 && c2.status === 409 && c2.json.code === 'busy' && c2.json.id === c1.json.run.id, c2.text);
  check('that refusal is friendly too', /featured briefs open instantly/.test(c2.json.error) && !RAW.test(c2.json.error), c2.json.error);
  const c3 = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand9', rivals: ['Rival9'] }, ip: '203.0.113.4', user: OTHER });
  check('another IP runs at the same time', c3.status === 202, c3.text);
  const c4 = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand10', rivals: ['Rival10'] }, ip: C, user: OTHER });
  check("the busy refusal does not hand out another account's run id", c4.status === 409 && c4.json.id === undefined, c4.text);
  await finish(c1);
  await finish(c3, OTHER);
  process.env.SCRIPTED_DELAY_MS = '30';
  check('the visitor IP is stored only as a hash', db.prepare('SELECT COUNT(*) AS n FROM taste_runs WHERE client_hash LIKE ?').get('%203.0.113%').n === 0
    && db.prepare('SELECT COUNT(*) AS n FROM taste_runs WHERE client_hash IS NOT NULL').get().n > 0);

  // ── Friendly failures ───────────────────────────────────────────────────────
  console.log('friendly failures');
  process.env.SCRIPTED_QUOTA_AFTER = '0';
  const spent = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Brand11', rivals: ['Rival11'] }, ip: '203.0.113.5' });
  const spentRun = await finish(spent);
  process.env.SCRIPTED_QUOTA_AFTER = '';
  check('when every model fails, the run ends with a friendly message', spentRun.status === 'error'
    && spentRun.error_message === runs.FRIENDLY.busy && !RAW.test(spentRun.error_message), spentRun.error_message);
  check('friendly messages cover timeouts and stored raw errors', runs.friendlyError('The agent ran out of time before writing the brief') === runs.FRIENDLY.timeout
    && runs.friendlyError('Groq request failed (429): Rate limit reached for model') === runs.FRIENDLY.busy
    && runs.friendlyError('TypeError: x is undefined') === runs.FRIENDLY.generic);
  check('no friendly message has a dash', !/[\u2013\u2014]/.test(Object.values(runs.FRIENDLY).join(' ')));
  db.prepare("UPDATE taste_runs SET error_message = 'Gemini request failed (429): You exceeded your current quota' WHERE id = ?").run(spentRun.id);
  runs.tidyStoredRuns();
  check('a raw error stored before this code is replaced at boot', db.prepare('SELECT error_message FROM taste_runs WHERE id = ?').get(spentRun.id).error_message === runs.FRIENDLY.busy);

  // ── Featured briefs and the script ──────────────────────────────────────────
  console.log('featured briefs');
  const { main: generate } = require('./scripts/generate-featured');
  const base = 'http://127.0.0.1:' + port;
  const noToken = await request(port, 'GET', '/internal/taste/featured', { ip: null });
  check('the internal routes need the token', noToken.status === 404);
  const { internalToken } = require('./src/lib/internalToken');
  const token = { 'x-internal-token': internalToken('taste-featured') };
  const viaProxy = await request(port, 'GET', '/internal/taste/featured', { ip: '198.51.100.99', headers: token });
  check('and refuse anything that came through a proxy', viaProxy.status === 404);
  const local = await request(port, 'GET', '/internal/taste/featured', { ip: null, headers: token });
  check('a local request with the token is answered', local.status === 200 && local.json.pairs.length === featured.FEATURED.length, local.text.slice(0, 120));

  // Without the test override, the featured chain is the run chain in its
  // order, and --provider narrows it to one provider's models.
  const llm = require('./src/taste/llm');
  const envKeys = ['FEATURED_CHAIN', 'LLM_CHAIN', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'BASETEN_API_KEY', 'BASETEN_MODELS'];
  const savedEnv = { ...process.env };
  delete process.env.FEATURED_CHAIN;
  Object.assign(process.env, {
    GEMINI_API_KEY: 'test', GROQ_API_KEY: 'test', OPENROUTER_API_KEY: 'test', BASETEN_API_KEY: 'test',
    BASETEN_MODELS: 'org/model-a,org/model-b', LLM_CHAIN: 'baseten:org/model-a,gemini,gemini:gemini-3.5-flash,baseten:org/model-b,groq,openrouter',
  });
  const ordered = llm.buildChain(featured.featuredChain()).map(e => e.key);
  const onlyGemini = llm.buildChain(featured.featuredChain('gemini')).map(e => e.key);
  const onlyBaseten = llm.buildChain(featured.featuredChain('baseten')).map(e => e.key);
  delete process.env.LLM_CHAIN;
  const defaultGemini = llm.buildChain(featured.featuredChain('gemini')).map(e => e.key);
  let unknownProvider = '';
  try { featured.featuredChain('nope'); } catch (err) { unknownProvider = err.message; }
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  check('the featured chain follows LLM_CHAIN, in its order', ordered.slice(0, 5).join() === 'baseten:org/model-a,gemini:gemini-3.6-flash,gemini:gemini-3.5-flash,baseten:org/model-b,groq:qwen/qwen3.8-27b'
    && ordered.slice(5).every(k => k.startsWith('openrouter:')), ordered.join(' > '));
  check('--provider gemini is both Gemini models', onlyGemini.join() === 'gemini:gemini-3.6-flash,gemini:gemini-3.5-flash'
    && defaultGemini.join() === onlyGemini.join(), onlyGemini.join() + ' | ' + defaultGemini.join());
  check('--provider baseten is the Baseten models in chain order', onlyBaseten.join() === 'baseten:org/model-a,baseten:org/model-b', onlyBaseten.join());
  check('an unknown provider is refused', /Unknown provider "nope"/.test(unknownProvider), unknownProvider);

  // An example from the old boot path: a brief, but not one the script wrote.
  const old = await runs.runExample('glossier-fenty', { brand: 'Glossier', rivals: ['Fenty Beauty'], city: null });
  const lines = [];
  process.env.SCRIPTED_QUOTA_AFTER = '3';
  const code1 = await generate(['--base', base, '--pause', '0'], l => lines.push(l));
  check('the script stops cleanly when the quota runs out', code1 === 2 && lines.some(l => /out of quota/.test(l))
    && lines.some(l => /Stopped with 3 of 10 ready\. Run this again/.test(l)), code1 + ' | ' + lines.join(' | '));
  const status1 = featured.featuredStatus();
  check('the first three pairs are current, in order', status1.slice(0, 3).every(p => p.status === 'current') && status1.slice(3).every(p => p.status !== 'current'),
    status1.map(p => p.status).join(','));
  check('the old example was replaced, not kept', !db.prepare('SELECT id FROM taste_runs WHERE id = ?').get(old.id)
    && featured.listFeatured().find(p => p.key === 'glossier-fenty').run.id !== old.id);
  check('the featured briefs come from the featured chain', db.prepare("SELECT COUNT(*) AS n FROM taste_runs WHERE example_version = 1 AND model LIKE 'scripted%'").get().n === 3);
  const failedFeatured = db.prepare("SELECT COUNT(*) AS n FROM taste_runs WHERE created_by = 0 AND status != 'done'").get().n;
  check('the attempt that hit the quota left no row behind', failedFeatured === 0, String(failedFeatured));

  process.env.SCRIPTED_QUOTA_AFTER = '';
  const lines2 = [];
  const code2 = await generate(['--base', base, '--pause', '0'], l => lines2.push(l));
  check('run again, it resumes: skips the done pairs and writes the rest', code2 === 0
    && lines2.filter(l => /already current, skipped/.test(l)).length === 3
    && lines2.some(l => /10 of 10 featured briefs ready/.test(l)), code2 + ' | ' + lines2.join(' | '));
  check('every pair is current', featured.featuredStatus().every(p => p.status === 'current'));

  const rows = runCount();
  const lines3 = [];
  const code3 = await generate(['--base', base, '--pause', '0'], l => lines3.push(l));
  check('a third run writes nothing', code3 === 0 && runCount() === rows && lines3.filter(l => /skipped/.test(l)).length === 10, lines3.join(' | '));
  check('the script says which chain it writes with', /one at a time with scripted:script$/.test(lines3[0]), lines3[0]);
  const pinned = [];
  const pinnedCode = await generate(['--base', base, '--pause', '0', '--provider', 'scripted'], l => pinned.push(l));
  check('--provider runs on that provider and still resumes', pinnedCode === 0 && /with scripted:script$/.test(pinned[0])
    && pinned.filter(l => /skipped/.test(l)).length === 10, pinned.join(' | '));
  const refused = [];
  const refusedCode = await generate(['--base', base, '--provider', 'nope'], l => refused.push(l));
  check('an unknown --provider stops before writing anything', refusedCode === 1 && /Cannot write featured briefs: Unknown provider "nope"/.test(refused.join(' ')), refused.join(' | '));

  const nikeBefore = featured.featuredStatus().find(p => p.key === 'nike-adidas-la').run_id;
  const code4 = await generate(['--base', base, '--pause', '0', '--force', '--only', 'nike-adidas-la'], () => {});
  const nikeAfter = featured.featuredStatus().find(p => p.key === 'nike-adidas-la').run_id;
  check('--force --only rewrites just that pair', code4 === 0 && nikeAfter !== nikeBefore && runCount() === rows);

  process.env.SCRIPTED_DELAY_MS = '400';
  const busy = await Promise.all([
    request(port, 'POST', '/internal/taste/featured/spotify-apple-music?force=1', { ip: null, headers: token }),
    new Promise(r => setTimeout(r, 20)).then(() => request(port, 'POST', '/internal/taste/featured/sephora-ulta-chicago?force=1', { ip: null, headers: token })),
  ]);
  process.env.SCRIPTED_DELAY_MS = '30';
  check('one featured brief at a time', busy[0].json.result === 'done' && busy[1].json.result === 'busy', busy.map(b => b.json.result).join(','));

  const chips = (await request(port, 'GET', '/api/taste/featured', { user: OTHER })).json.pairs;
  check('the page lists all ten pairs with a brief to open', chips.length === 10 && chips.every(p => p.run?.id));
  const chipHit = await request(port, 'POST', '/api/taste/runs', { body: { brand: "McDonald's", rivals: ['Burger King'], city: 'Miami' }, user: OTHER, ip: '203.0.113.9' });
  check('typing a featured pair opens its cached brief, for any account', chipHit.status === 200 && chipHit.json.cached
    && chipHit.json.run.id === chips.find(p => p.key === 'mcdonalds-burger-king-miami').run.id, chipHit.text);
  const dunkin = await request(port, 'POST', '/api/taste/runs', { body: { brand: 'Starbucks', rivals: ['Dunkin'], city: 'NYC' }, user: OTHER, ip: '203.0.113.9' });
  check('so does a common short form of it', dunkin.status === 200 && dunkin.json.cached, dunkin.text);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
