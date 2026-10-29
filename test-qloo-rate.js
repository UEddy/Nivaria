// Qloo's hackathon limit is 10 requests per second. Every Qloo call goes
// through src/qloo/client.js, which spaces requests MIN_GAP_MS apart across
// the whole process, so the busiest the server gets (several visitors' runs
// at once, each firing a turn's tool calls in parallel, plus autocomplete,
// plus retries after a 429) still has to stay under it.
//
//   node test-qloo-rate.js
//
// The real client runs over a stubbed HTTP layer that answers with the fake
// Qloo's synthetic data (scripts/qloo-fake.js) and records when each request
// leaves. Three agent runs with a city (geo_gap labels cells with a burst of
// parallel calls), twenty autocomplete lookups and a few 429s go at once; the
// check is the most requests seen in any one-second window.

const axios = require('axios');
const client = require('./src/qloo/client');

// The fake patches the client when loaded; keep the real client and use the
// fake only to build response bodies.
const real = { search: client.search, insights: client.insights, compare: client.compare };
const fake = require('./scripts/qloo-fake');
Object.assign(client, real);

process.env.QLOO_API_KEY = 'test';
process.env.LLM_CHAIN = 'scripted';
process.env.SCRIPTED_DELAY_MS = '20';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  ok   ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

const sent = [];        // ms timestamp of every request that left the client
let rateLimitsLeft = 6; // answer this many requests with a 429 first

axios.get = async (url, { params = {} } = {}) => {
  sent.push(Date.now());
  if (rateLimitsLeft > 0) {
    rateLimitsLeft -= 1;
    throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, headers: { 'retry-after': '0' }, data: {} } });
  }
  const path = new URL(url).pathname;
  let data;
  if (path === '/search') data = await fake.search(params.query, { types: params.types });
  else if (path === '/v2/insights') data = await fake.insights(params['filter.type'], params);
  else if (path === '/v2/analysis/compare') data = await fake.compare(params['a.signal.interests.entities'], params['b.signal.interests.entities']);
  else data = {};
  return { data, headers: { 'x-second-ratelimit-remaining': '9' } };
};

function peakPerSecond(times) {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i += 1) {
    while (t[i] - t[j] >= 1000) j += 1;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

(async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  const { runTasteAgent } = require('./src/taste/agent');
  const started = Date.now();
  const results = await Promise.allSettled([
    runTasteAgent({ brand: 'Starbucks', rivals: ["Dunkin' Donuts"], city: 'New York' }),
    runTasteAgent({ brand: 'Nike', rivals: ['Adidas'], city: 'Los Angeles' }),
    runTasteAgent({ brand: 'Sephora', rivals: ['Ulta'], city: 'Chicago' }),
    ...Array.from({ length: 20 }, (_, i) => client.search('brand ' + i, { types: 'urn:entity:brand', take: 6 })),
  ]);
  console.warn = origWarn;

  const runsOk = results.slice(0, 3).every(r => r.status === 'fulfilled' && r.value.brief?.headline);
  check('three runs at once all finish', runsOk, results.slice(0, 3).map(r => r.reason?.message || 'ok').join('; '));
  check('the autocomplete lookups all answer', results.slice(3).every(r => r.status === 'fulfilled'));
  check('the 429s were retried, not passed on', rateLimitsLeft === 0 && runsOk);

  const peak = peakPerSecond(sent);
  const secs = (Date.now() - started) / 1000;
  console.log('  ' + sent.length + ' requests in ' + secs.toFixed(1) + 's, peak ' + peak + ' in any one second');
  check('never more than 10 requests in any one second', peak <= 10, String(peak));
  check('the client actually ran near its pace (not trivially idle)', peak >= 7, String(peak));

  // A repeat of a request inside the cache window never leaves the process.
  const before = sent.length;
  await client.search('brand 3', { types: 'urn:entity:brand', take: 6 });
  check('a repeat request is served from the client cache', sent.length === before);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
