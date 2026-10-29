// Qloo smoke test: one real call per endpoint the Taste Gap agent uses.
//
//   node scripts/qloo-smoke.js [brand] [rival] [city]
//
// Each full response is written to data/qloo-samples/<name>.json (data/ is
// git-ignored; Qloo response data must never land in the public repo) and a
// trimmed copy is printed so the parsers can be written against real shapes.
// A 200 with an empty result is flagged, because Qloo silently ignores params
// it does not recognise.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const qloo = require('../src/qloo/client');

const BRAND = process.argv[2] || 'Glossier';
const RIVAL = process.argv[3] || 'Fenty Beauty';
const CITY = process.argv[4] || 'New York';

const OUT_DIR = path.join(__dirname, '..', 'data', 'qloo-samples');

// Arrays keep their first two items, strings are cut at 90 chars, and akas and
// translated descriptions are collapsed, so the printed copy shows the real
// structure and values without the bulk.
function trim(v, depth = 0) {
  if (Array.isArray(v)) {
    const head = v.slice(0, 2).map(x => trim(x, depth + 1));
    if (v.length > 2) head.push('...(' + v.length + ' items total)');
    return head;
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'akas' || k === 'short_descriptions') && Array.isArray(x)) {
        out[k] = '[' + x.length + ' entries]';
      } else {
        out[k] = trim(x, depth + 1);
      }
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 90) return v.slice(0, 90) + '...';
  return v;
}

function countResults(data) {
  const r = data?.results;
  if (Array.isArray(r)) return r.length;
  if (r && typeof r === 'object') {
    for (const k of Object.keys(r)) if (Array.isArray(r[k])) return r[k].length;
    return Object.keys(r).length;
  }
  return null;
}

async function probe(name, fn, { expectEmpty = false } = {}) {
  const t0 = Date.now();
  try {
    const data = await fn();
    fs.writeFileSync(path.join(OUT_DIR, name + '.json'), JSON.stringify(data, null, 2));
    const n = countResults(data);
    let flag = '';
    if (expectEmpty && n !== 0) flag = '  <-- expected empty: the filter was ignored';
    if (!expectEmpty && n === 0) flag = '  <-- EMPTY: check param names';
    console.log('\n=== ' + name + ' (' + (Date.now() - t0) + 'ms, results: ' + n + ')' + flag);
    console.log(JSON.stringify(trim(data), null, 1));
    return data;
  } catch (err) {
    console.log('\n=== ' + name + ' FAILED: ' + err.message);
    if (err.qloo) console.log(JSON.stringify(err.qloo, null, 1));
    return null;
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('base URL: ' + (process.env.QLOO_BASE_URL || qloo.DEFAULT_BASE_URL));

  const a = await probe('search-brand', () => qloo.search(BRAND, { types: 'urn:entity:brand', take: 3 }));
  const b = await probe('search-rival', () => qloo.search(RIVAL, { types: 'urn:entity:brand', take: 3 }));
  // Same query with a non-brand type should find nothing. A hit means the
  // types param is being ignored.
  await probe('search-types-check', () => qloo.search(BRAND, { types: 'urn:entity:movie', take: 3 }),
    { expectEmpty: true });

  const aId = a?.results?.[0]?.entity_id;
  const bId = b?.results?.[0]?.entity_id;
  if (!aId || !bId) {
    console.log('\nCould not resolve both brands; stopping.');
    return;
  }
  console.log('\nresolved: ' + BRAND + ' = ' + aId + ', ' + RIVAL + ' = ' + bId);
  const sig = { 'signal.interests.entities': aId };

  // filter.type, take and model are accepted but change nothing on compare.
  await probe('compare', () => qloo.compare(aId, bId));

  for (const t of ['artist', 'movie', 'brand', 'tv_show', 'podcast', 'place']) {
    await probe('insights-' + t, () => qloo.insights('urn:entity:' + t, { ...sig, take: 3 }));
  }
  await probe('insights-place-city', () => qloo.insights('urn:entity:place', {
    ...sig, 'filter.location.query': CITY, take: 3,
  }));

  // The rival's top artists, then our audience's affinity for those same
  // artists: the per-entity gap the agent ranks on.
  const rivalArtists = await probe('insights-artist-rival', () => qloo.insights('urn:entity:artist', {
    'signal.interests.entities': bId, take: 5,
  }));
  const rivalIds = (rivalArtists?.results?.entities || []).map(e => e.entity_id);
  if (rivalIds.length) {
    await probe('insights-artist-crossscore', () => qloo.insights('urn:entity:artist', {
      ...sig, 'filter.results.entities': rivalIds, take: rivalIds.length,
    }));
  }

  // Unscoped urn:tag returns generic place tags at affinity 1; scope it.
  await probe('insights-tag-music', () => qloo.insights('urn:tag', {
    ...sig, 'filter.tag.types': 'urn:tag:genre:music', take: 5,
  }));
  await probe('insights-tag-brand', () => qloo.insights('urn:tag', {
    ...sig, 'filter.parents.types': 'urn:entity:brand', take: 5,
  }));
  await probe('insights-demographics', () => qloo.insights('urn:demographics', sig));
  // take is ignored here: a city returns the full grid (1,000 to 2,500 points).
  await probe('insights-heatmap', () => qloo.insights('urn:heatmap', {
    ...sig, 'filter.location.query': CITY,
  }));

  // Hackathon trending data ends 2026-06-25, so a window ending today is empty.
  await probe('trending', () => qloo.trending(aId, {
    'filter.type': 'urn:entity:brand',
    'filter.start_date': '2026-01-01',
    'filter.end_date': '2026-06-30',
    take: 50,
  }));

  await probe('tags', () => qloo.tags({ 'filter.query': 'skincare', take: 5 }));

  console.log('\nquota after run: ' + JSON.stringify(qloo.quota()));
  console.log('full responses saved under ' + OUT_DIR);
}

main().catch(err => { console.error(err.message); process.exit(1); });
