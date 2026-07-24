// Unit tests for over-discovery and the target-count cap ordering.
//   - poolSizeFor: discovery over-fetches DISCOVERY_MULTIPLIER x targetCount,
//     bounded by MAX_POOL (src/outbound/provider.js).
//   - freshnessBucket / selectTopLeads: the targetCount cap is applied LAST, to
//     the gate survivors, ordered freshness-first then by score
//     (src/outbound/pipeline.js).
// Pure, no DB/network — run with `node test-outbound-cap.js`.

const assert = require('assert');
const { poolSizeFor, DISCOVERY_MULTIPLIER, MAX_POOL } = require('./src/outbound/provider');
const { freshnessBucket, selectTopLeads } = require('./src/outbound/pipeline');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  try { assert.strictEqual(actual, expected); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`); fail++; }
}
function deq(actual, expected, label) {
  try { assert.deepStrictEqual(actual, expected); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`); fail++; }
}

const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

// ── poolSizeFor: over-discovery, multiplied then bounded ──────────────────────
eq(DISCOVERY_MULTIPLIER >= 1, true, 'DISCOVERY_MULTIPLIER is at least 1');
eq(poolSizeFor(1), Math.min(DISCOVERY_MULTIPLIER, MAX_POOL), 'targetCount 1 -> multiplier (or MAX_POOL)');
eq(poolSizeFor(5), Math.min(5 * DISCOVERY_MULTIPLIER, MAX_POOL), 'targetCount 5 -> 5x multiplier, bounded');
eq(poolSizeFor(10) >= 10, true, 'pool for targetCount 10 is larger than the target');
eq(poolSizeFor(1000), MAX_POOL, 'huge targetCount is bounded by MAX_POOL');
eq(poolSizeFor(0), Math.min(10 * DISCOVERY_MULTIPLIER, MAX_POOL), 'invalid targetCount falls back to 10');

// ── freshnessBucket: matches store.js boundaries ──────────────────────────────
eq(freshnessBucket(iso(3)), 0, 'bucket 0: this week');
eq(freshnessBucket(iso(20)), 1, 'bucket 1: this month');
eq(freshnessBucket(iso(60)), 2, 'bucket 2: last 3 months');
eq(freshnessBucket(iso(120)), 3, 'bucket 3: three to six months');
eq(freshnessBucket(null), 4, 'bucket 4: undated');
eq(freshnessBucket('not-a-date'), 4, 'bucket 4: unparseable date is undated, not stale');
eq(freshnessBucket(iso(300)), 5, 'bucket 5: stale (>180 days)');

// ── selectTopLeads: cap LAST, freshness-first then score ──────────────────────
// A pool of gate survivors, deliberately out of order.
const survivors = [
  { company: 'Stale-High',  trigger_at: iso(300), score: 99 }, // bucket 5
  { company: 'Fresh-Low',   trigger_at: iso(2),   score: 61 }, // bucket 0
  { company: 'Fresh-High',  trigger_at: iso(2),   score: 88 }, // bucket 0
  { company: 'Month-High',  trigger_at: iso(20),  score: 95 }, // bucket 1
  { company: 'Undated-High',trigger_at: null,     score: 97 }, // bucket 4
];

// targetCount 2 keeps the two freshest, score breaking the tie within a bucket.
const two = selectTopLeads(survivors, 2);
deq(two.kept.map(l => l.company), ['Fresh-High', 'Fresh-Low'], 'cap keeps freshest bucket, score breaks the tie');
eq(two.capped, 3, 'capped counts survivors beyond the target');

// A higher-scoring stale/undated lead never outranks a fresher one.
const three = selectTopLeads(survivors, 3);
deq(three.kept.map(l => l.company), ['Fresh-High', 'Fresh-Low', 'Month-High'], 'freshness dominates score across buckets');
eq(three.capped, 2, 'capped is the remainder');

// Cap at or above pool size keeps everyone, capped 0.
const all = selectTopLeads(survivors, 10);
eq(all.kept.length, 5, 'targetCount >= pool keeps all survivors');
eq(all.capped, 0, 'nothing capped when target covers the pool');

// Empty pool is safe.
deq(selectTopLeads([], 5), { kept: [], capped: 0 }, 'empty survivor pool is safe');

// Does not mutate the input array order.
eq(survivors[0].company, 'Stale-High', 'selectTopLeads does not mutate the input order');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
