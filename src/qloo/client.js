// Qloo Taste AI client: a thin GET wrapper for the Taste Gap agent.
//
// ── API reality (verified 2026-10-29 against the hackathon key) ───────────────
// The hackathon key only works on https://hackathon.api.qloo.com; staging and
// production answer 401. Auth is the X-Api-Key header, never Bearer and never a
// query param. Every endpoint is a GET with query-string params, and arrays go
// comma-joined ("a,b"), not repeated or bracketed (axios would send "key[]=a").
//
// Responses carry the quota in headers: x-second-ratelimit-limit is 10 and
// x-month-ratelimit-limit is 50000. One agent run fans out a dozen or more
// calls, so requests are spaced MIN_GAP_MS apart to stay under the per-second
// cap, withRetry() covers any 429 that still gets through, and identical
// requests are served from an in-memory TTL cache (caching server-side is
// allowed by the hackathon rules; committing response data is not).
//
// Qloo silently ignores params it does not recognise and answers 200 with an
// empty result, so an empty payload usually means a misspelled param, not
// missing data. /recs and /recommendations are legacy and unsupported, and this
// client refuses them outright.
//
// ── Response shapes (scripts/qloo-smoke.js saves full samples) ────────────────
//   /search             { results: [ { entity_id, name, types[], popularity,
//                         properties, tags[] {tag_id, name, type} } ] }
//   /v2/insights entity { results: { entities: [ { entity_id, name, subtype,
//                         popularity, query: { affinity, measurements:
//                         { audience_growth } }, properties, tags[], external } ] } }
//                         filter.results.entities=<ids> scores this audience on
//                         exactly those entities (the cross-brand gap).
//   /v2/insights urn:tag      { results: { tags: [ { tag_id, name, subtype,
//                             query: { affinity } } ] } }. Unscoped it returns
//                             generic place tags; pass filter.tag.types or
//                             filter.parents.types.
//   /v2/insights urn:demographics { results: { demographics: [ { entity_id,
//                             query: { age: { 24_and_younger .. 55_and_older },
//                             gender: { male, female } } } ] } }, scores -1..1.
//   /v2/insights urn:heatmap  { results: { heatmap: [ { location: { latitude,
//                             longitude, geohash }, query: { affinity,
//                             affinity_rank, popularity } } ] }, query:
//                             { localities } }. take is ignored; a city is the
//                             full grid, 1,000 to 2,500 points.
//   /v2/analysis/compare { results: { tags[] (shared, query.score), a[], b[]
//                         (unique to each side), matchEntities[] } }. A tag-level
//                         diff of the two entities' own tags; filter.type, take
//                         and model change nothing.
//   /v2/trending        { results: { trending: [ { date, population_percentile,
//                         population_rank (string), population_rank_velocity,
//                         velocity_fold_change, population_percent_delta } ] } },
//                         newest first. One entity per call. Hackathon data ends
//                         2026-06-25 and is flat across 2026 for the brands and
//                         artists sampled.

const axios = require('axios');
const { withRetry, sleep } = require('../lib/retry');

const DEFAULT_BASE_URL = 'https://hackathon.api.qloo.com';
const HTTP_TIMEOUT_MS = 20000;

// 10 requests per second is the hackathon cap. 120ms keeps us at about 8.
const MIN_GAP_MS = 120;

// Taste data moves weekly at the fastest (trending is weekly buckets), so a
// few hours of reuse costs nothing in freshness and saves quota on re-runs.
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

const cache = new Map();      // key -> { expiresAt, data }
const inflight = new Map();   // key -> Promise, so concurrent duplicates share one call
let nextSlotAt = 0;
let lastQuota = null;

function baseUrl() { return (process.env.QLOO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''); }
function apiKey() { return process.env.QLOO_API_KEY || ''; }

// Flatten params to the string form Qloo expects: arrays comma-joined, and
// null, undefined, empty strings and empty arrays dropped so an unset option
// never reaches the API as a blank (and silently ignored) param.
function serializeParams(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const s = Array.isArray(v) ? v.filter(x => x != null && x !== '').join(',') : String(v);
    if (s === '') continue;
    out[k] = s;
  }
  return out;
}

function cacheKey(path, flat) {
  const qs = Object.keys(flat).sort().map(k => k + '=' + flat[k]).join('&');
  return path + '?' + qs;
}

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { cache.delete(key); return null; }
  return hit.data;
}

function writeCache(key, data, ttlMs) {
  if (ttlMs <= 0) return;
  cache.delete(key);
  cache.set(key, { expiresAt: Date.now() + ttlMs, data });
  // Map keeps insertion order, so the first key is the oldest write.
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

// Reserve the next send slot. Callers that arrive together are queued
// MIN_GAP_MS apart instead of bursting past the per-second cap.
async function waitForSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

function recordQuota(headers) {
  const n = name => {
    const v = Number(headers?.[name]);
    return Number.isFinite(v) ? v : null;
  };
  lastQuota = {
    second_remaining: n('x-second-ratelimit-remaining'),
    month_remaining: n('x-month-ratelimit-remaining'),
    month_limit: n('x-month-ratelimit-limit'),
  };
}

// axios errors carry the request config, X-Api-Key included, so logging one
// would leak the key. Rethrow a plain Error that keeps only what callers and
// withRetry() need: status, Retry-After headers, and Qloo's own message.
function toQlooError(err, path) {
  const status = err?.response?.status || null;
  const body = err?.response?.data;
  const detail = body?.error?.message || body?.message
    || (typeof body?.error === 'string' ? body.error : null)
    || (body ? JSON.stringify(body).slice(0, 300) : err?.message);
  const e = new Error('Qloo ' + path + ' failed' + (status ? ' (' + status + ')' : '') + ': ' + detail);
  e.status = status;
  e.qloo = body || null;
  if (err?.response?.headers) e.headers = err.response.headers;
  if (err?.code) e.code = err.code;
  return e;
}

// GET a Qloo endpoint. Returns the parsed JSON body. Pass { ttlMs: 0 } to skip
// the cache for one call.
async function qlooGet(path, params = {}, { ttlMs = DEFAULT_TTL_MS } = {}) {
  if (/\/(recs|recommendations)\b/.test(path)) {
    throw new Error('Qloo ' + path + ' is a legacy endpoint and is not supported; use /v2/insights');
  }
  const key = apiKey();
  if (!key) throw new Error('QLOO_API_KEY is not set');

  const flat = serializeParams(params);
  const ck = cacheKey(path, flat);
  const cached = ttlMs > 0 ? readCache(ck) : null;
  if (cached) return cached;
  if (inflight.has(ck)) return inflight.get(ck);

  const call = (async () => {
    try {
      const resp = await withRetry(async () => {
        await waitForSlot();
        return axios.get(baseUrl() + path, {
          params: flat,
          headers: { 'X-Api-Key': key, Accept: 'application/json' },
          timeout: HTTP_TIMEOUT_MS,
        });
      }, { label: 'qloo ' + path });
      recordQuota(resp.headers);
      writeCache(ck, resp.data, ttlMs);
      return resp.data;
    } catch (err) {
      throw toQlooError(err, path);
    } finally {
      inflight.delete(ck);
    }
  })();
  inflight.set(ck, call);
  return call;
}

// ── Endpoint helpers ──────────────────────────────────────────────────────────
// Each takes Qloo's own dotted param names so a call reads the same as the
// docs. They add only the required params; everything else passes through.

// Resolve a name to entities. types: e.g. 'urn:entity:brand' or an array.
function search(query, { types, take = 5, ...rest } = {}, opts) {
  return qlooGet('/search', { query, types, take, ...rest }, opts);
}

// Insights for one filter.type: 'urn:entity:artist', 'urn:tag',
// 'urn:demographics', 'urn:heatmap' and so on.
function insights(filterType, params = {}, opts) {
  return qlooGet('/v2/insights', { 'filter.type': filterType, ...params }, opts);
}

// Head-to-head audience comparison of two signal sets.
function compare(aEntities, bEntities, params = {}, opts) {
  return qlooGet('/v2/analysis/compare', {
    'a.signal.interests.entities': aEntities,
    'b.signal.interests.entities': bEntities,
    ...params,
  }, opts);
}

// Weekly trend series (percentile, rank, velocity, acceleration) for entities.
function trending(entities, params = {}, opts) {
  return qlooGet('/v2/trending', { 'signal.interests.entities': entities, ...params }, opts);
}

// Tag lookup. Tag IDs for any filter must come from here, not free text.
function tags(params = {}, opts) {
  return qlooGet('/v2/tags', params, opts);
}

function quota() { return lastQuota; }
function clearCache() { cache.clear(); }

module.exports = {
  qlooGet, search, insights, compare, trending, tags, quota, clearCache,
  serializeParams, DEFAULT_BASE_URL,
};
