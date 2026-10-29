// Taste Gap: Anthropic tool definitions over the Qloo client.
//
// Each tool wraps one or more Qloo calls and hands the model a trimmed result:
// names, ids and rounded scores, never the 40-odd property fields Qloo returns
// per entity. The heavier data (images, the full heatmap grid, every scored
// entity) is kept on the run context instead, so the UI can chart it and the
// agent can attach real numbers to the brief without the model restating them.
//
// The tools are composite on purpose. Two findings from the smoke tests
// (scripts/qloo-smoke.js) shaped them:
//   - /v2/analysis/compare is only a small tag diff, so the audience gap comes
//     from /v2/insights with filter.results.entities: take the rival
//     audience's top entities in a domain, then score exactly those entities
//     for our audience. gap = rival affinity minus ours.
//   - Both brands' heatmaps for one locality land on the same geohash grid, so
//     the geographic gap is a join on geohash, computed here. The model sees
//     only the top cells, each labelled with a neighbourhood looked up through
//     filter.location.geohash.
//
// Every id a tool accepts must have come out of search_brands or find_city in
// the same run. That keeps the model from passing an id it invented.

const qloo = require('./client');

// Rival entities scored per domain. 15 gives the model enough to see a cluster
// (several reality fashion shows, not one) at two Qloo calls per domain.
const GAP_TAKE = 15;

// Heatmap cells handed to the model, and how many of them get a neighbourhood
// label (one Qloo call each). Cells below GEO_MIN_POPULARITY are thin on
// signal, so they are skipped when enough busier cells exist.
const GEO_HOTSPOTS = 12;
const GEO_LABELED = 8;
const GEO_OURS_TOP = 3;
const GEO_MIN_POPULARITY = 0.4;

// A cell counts as "led" by one side when the affinity gap passes this.
const GEO_LEAD_THRESHOLD = 0.1;

// brand_positioning list caps (Nike vs Adidas returns 45 shared tags).
const POSITIONING_SHARED_MAX = 15;
const POSITIONING_ONLY_MAX = 12;

const DOMAINS = {
  artist:  { type: 'urn:entity:artist',  label: 'music' },
  movie:   { type: 'urn:entity:movie',   label: 'film' },
  tv_show: { type: 'urn:entity:tv_show', label: 'TV' },
  place:   { type: 'urn:entity:place',   label: 'places' },
  brand:   { type: 'urn:entity:brand',   label: 'other brands' },
};

const AGE_BUCKETS = ['24_and_younger', '25_to_29', '30_to_34', '35_to_44', '45_to_54', '55_and_older'];

function r3(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
}

function toolError(message) {
  const e = new Error(message);
  e.toolError = true;
  return e;
}

// Per-run state shared by every tool call in one agent run.
function createContext() {
  return {
    entities: new Map(),     // entity_id -> { name, image, type }
    localities: new Map(),   // locality_id -> { name, disambiguation }
    gaps: {},                // rival_id -> domain -> [scored items]
    gapIndex: new Map(),     // rival_id + ':' + entity_id -> scored item
    geo: {},                 // rival_id -> { locality, cells, hotspots, our_strongest, stats }
    demographics: {},        // rival_id -> { age, gender }
    positioning: {},         // rival_id -> { shared, brand_only, rival_only }
  };
}

function entityName(ctx, id) { return ctx.entities.get(id)?.name || id; }
function localityName(ctx, id) { return ctx.localities.get(id)?.name || id; }

function requireBrand(ctx, id, field) {
  if (!id || !ctx.entities.has(id)) {
    throw toolError(field + ' is not a brand from search_brands. Call search_brands and pass an entity_id it returned.');
  }
}

function requireLocality(ctx, id) {
  if (!id || !ctx.localities.has(id)) {
    throw toolError('locality_id is not a city from find_city. Call find_city and pass a locality_id it returned.');
  }
}

function requirePair(ctx, brandId, rivalId) {
  requireBrand(ctx, brandId, 'brand_id');
  requireBrand(ctx, rivalId, 'rival_id');
  if (brandId === rivalId) throw toolError('brand_id and rival_id must be different brands.');
}

const entitiesOf = d => d?.results?.entities || [];

// Up to three genre-style tag names, so the model can see what kind of thing
// an entity is without the full tag list (90-odd tags per artist).
function descriptors(e) {
  const out = [];
  for (const t of e.tags || []) {
    const type = String(t.type || '');
    if (!type.includes(':genre:') && !type.includes(':category:')) continue;
    const name = String(t.name || '').trim();
    if (name && !out.some(x => x.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length === 3) break;
  }
  return out;
}

// ── search_brands ─────────────────────────────────────────────────────────────

async function searchBrands(ctx, { query }) {
  if (!query || typeof query !== 'string') throw toolError('query is required.');
  const d = await qloo.search(query.trim(), { types: 'urn:entity:brand', take: 5 });
  const results = (d?.results || []).map(e => {
    const p = e.properties || {};
    ctx.entities.set(e.entity_id, { name: e.name, image: p.image?.url || null, type: 'brand' });
    return {
      entity_id: e.entity_id,
      name: e.name,
      popularity: r3(e.popularity),
      description: p.short_description || null,
      parent_organization: p.parent_organization || null,
      official_site: p.official_site || null,
    };
  });
  return {
    result: { query, results },
    summary: results.length ? 'Found ' + results.slice(0, 3).map(r => r.name).join(', ') : 'No brands matched',
  };
}

// ── find_city ─────────────────────────────────────────────────────────────────

async function findCity(ctx, { query }) {
  if (!query || typeof query !== 'string') throw toolError('query is required.');
  const d = await qloo.search(query.trim(), { types: 'urn:entity:locality', take: 5 });
  const results = (d?.results || []).map(e => {
    ctx.localities.set(e.entity_id, { name: e.name, disambiguation: e.disambiguation || e.name });
    return {
      locality_id: e.entity_id,
      name: e.name,
      disambiguation: e.disambiguation || null,
      popularity: r3(e.popularity),
    };
  });
  return {
    result: { query, results },
    summary: results.length ? 'Found ' + results.slice(0, 2).map(r => r.disambiguation || r.name).join('; ') : 'No cities matched',
  };
}

// ── audience_gap ──────────────────────────────────────────────────────────────

async function audienceGap(ctx, { brand_id, rival_id, domain, locality_id }) {
  requirePair(ctx, brand_id, rival_id);
  const cfg = DOMAINS[domain];
  if (!cfg) throw toolError('domain must be one of: ' + Object.keys(DOMAINS).join(', ') + '.');
  if (domain === 'place' && !locality_id) throw toolError('The place domain needs a locality_id from find_city.');
  if (locality_id) requireLocality(ctx, locality_id);
  const loc = locality_id ? { 'filter.location': locality_id } : {};

  // Ask for two extra so the brand and rival themselves can be dropped from
  // the brand domain without coming up short.
  const rivalTop = await qloo.insights(cfg.type, {
    'signal.interests.entities': rival_id, take: GAP_TAKE + 2, ...loc,
  });
  const exclude = new Set([brand_id, rival_id]);
  const top = entitiesOf(rivalTop).filter(e => !exclude.has(e.entity_id)).slice(0, GAP_TAKE);
  if (!top.length) {
    return { result: { domain, items: [], note: 'Qloo returned no ' + cfg.label + ' for this rival.' }, summary: 'No results' };
  }

  const ids = top.map(e => e.entity_id);
  const cross = await qloo.insights(cfg.type, {
    'signal.interests.entities': brand_id, 'filter.results.entities': ids, take: ids.length, ...loc,
  });
  const ours = new Map(entitiesOf(cross).map(e => [e.entity_id, e.query?.affinity]));

  const items = top.map(e => {
    const rivalAff = r3(e.query?.affinity);
    const ourAff = r3(ours.get(e.entity_id));
    const item = {
      entity_id: e.entity_id,
      name: e.name,
      domain,
      rival_affinity: rivalAff,
      our_affinity: ourAff,
      gap: rivalAff != null && ourAff != null ? r3(rivalAff - ourAff) : null,
      popularity: r3(e.popularity),
      descriptors: descriptors(e),
      image: e.properties?.image?.url || null,
    };
    if (domain === 'place') item.neighborhood = e.properties?.geocode?.name || null;
    return item;
  }).sort((a, b) => (b.gap ?? -Infinity) - (a.gap ?? -Infinity));

  // A later call for the same rival and domain (say, city-scoped) replaces the
  // earlier one, and both stay findable in the index for evidence lookup.
  ctx.gaps[rival_id] = ctx.gaps[rival_id] || {};
  ctx.gaps[rival_id][domain] = items;
  for (const it of items) ctx.gapIndex.set(rival_id + ':' + it.entity_id, it);

  const scored = items.filter(it => it.gap != null);
  const mean = scored.length ? r3(scored.reduce((s, it) => s + it.gap, 0) / scored.length) : null;
  const strong = scored.filter(it => it.gap >= 0.1).length;
  const lead = scored[0];

  return {
    result: {
      domain,
      city: locality_id ? localityName(ctx, locality_id) : null,
      mean_gap: mean,
      strong_gaps: strong,
      items: items.map(({ image, domain: _d, ...rest }) => rest),
    },
    summary: lead
      ? 'Biggest gap: ' + lead.name + ' (' + lead.rival_affinity + ' vs ' + lead.our_affinity + '), mean gap ' + mean
      : 'No overlap scored',
  };
}

// ── geo_gap ───────────────────────────────────────────────────────────────────

// The neighbourhood a cell sits in, read off the top places Qloo returns for
// that geohash. Many places carry no neighbourhood name but all carry the
// borough or county (geocode.admin2_region), so area is the fallback label.
// Best-effort: a failed lookup leaves the cell unlabelled.
function mostCommon(values) {
  const counts = {};
  for (const v of values) if (v) counts[v] = (counts[v] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

async function labelCell(cell, signalId) {
  try {
    const d = await qloo.insights('urn:entity:place', {
      'signal.interests.entities': signalId, 'filter.location.geohash': cell.geohash, take: 3,
    });
    const places = entitiesOf(d);
    cell.neighborhood = mostCommon(places.map(p => p.properties?.geocode?.name));
    cell.area = mostCommon(places.map(p => p.properties?.geocode?.admin2_region));
    cell.top_places = places.map(p => p.name).slice(0, 3);
  } catch (_) {
    cell.neighborhood = null;
    cell.area = null;
    cell.top_places = [];
  }
}

const cellLabel = c => c.neighborhood || c.area || c.geohash;

async function geoGap(ctx, { brand_id, rival_id, locality_id }) {
  requirePair(ctx, brand_id, rival_id);
  requireLocality(ctx, locality_id);

  const [mine, theirs] = await Promise.all([brand_id, rival_id].map(id =>
    qloo.insights('urn:heatmap', { 'signal.interests.entities': id, 'filter.location': locality_id })));
  const ours = new Map((mine?.results?.heatmap || []).map(p => [p.location.geohash, p]));

  const cells = [];
  for (const p of theirs?.results?.heatmap || []) {
    const o = ours.get(p.location.geohash);
    if (!o) continue;
    const rivalAff = r3(p.query?.affinity);
    const ourAff = r3(o.query?.affinity);
    if (rivalAff == null || ourAff == null) continue;
    cells.push({
      geohash: p.location.geohash,
      lat: p.location.latitude,
      lng: p.location.longitude,
      rival_affinity: rivalAff,
      our_affinity: ourAff,
      gap: r3(rivalAff - ourAff),
      popularity: r3(p.query?.popularity),
    });
  }
  if (!cells.length) {
    return { result: { cells_compared: 0, note: 'Qloo returned no overlapping heatmap cells for this city.' }, summary: 'No overlapping cells' };
  }

  const dense = cells.filter(c => c.popularity != null && c.popularity >= GEO_MIN_POPULARITY);
  const pool = dense.length >= GEO_HOTSPOTS ? dense : cells;
  const hotspots = [...pool].sort((a, b) => b.gap - a.gap).slice(0, GEO_HOTSPOTS).map(c => ({ ...c }));
  const ourStrongest = [...pool].sort((a, b) => a.gap - b.gap).slice(0, GEO_OURS_TOP).map(c => ({ ...c }));
  await Promise.all([
    ...hotspots.slice(0, GEO_LABELED).map(c => labelCell(c, rival_id)),
    ...ourStrongest.map(c => labelCell(c, brand_id)),
  ]);

  const sortedGaps = cells.map(c => c.gap).sort((a, b) => a - b);
  const stats = {
    cells_compared: cells.length,
    median_gap: sortedGaps[Math.floor(sortedGaps.length / 2)],
    share_rival_leads: r3(cells.filter(c => c.gap >= GEO_LEAD_THRESHOLD).length / cells.length),
    share_we_lead: r3(cells.filter(c => c.gap <= -GEO_LEAD_THRESHOLD).length / cells.length),
  };
  ctx.geo[rival_id] = {
    locality: { locality_id, name: localityName(ctx, locality_id) },
    cells, hotspots, our_strongest: ourStrongest, stats,
  };

  const forModel = c => ({
    geohash: c.geohash,
    neighborhood: c.neighborhood ?? null,
    area: c.area ?? null,
    top_places: c.top_places,
    rival_affinity: c.rival_affinity,
    our_affinity: c.our_affinity,
    gap: c.gap,
    popularity: c.popularity,
  });
  const top = hotspots[0];
  return {
    result: {
      city: localityName(ctx, locality_id),
      ...stats,
      rival_hotspots: hotspots.map(forModel),
      our_strongest: ourStrongest.map(forModel),
    },
    summary: 'Rival leads in ' + Math.round(stats.share_rival_leads * 100) + '% of ' + cells.length
      + ' cells; widest gap in ' + cellLabel(top) + ' (' + top.rival_affinity + ' vs ' + top.our_affinity + ')',
  };
}

// ── demographic_gap ───────────────────────────────────────────────────────────

async function demographicGap(ctx, { brand_id, rival_id }) {
  requirePair(ctx, brand_id, rival_id);
  const [mine, theirs] = await Promise.all([brand_id, rival_id].map(id =>
    qloo.insights('urn:demographics', { 'signal.interests.entities': id })));
  const o = mine?.results?.demographics?.[0]?.query;
  const r = theirs?.results?.demographics?.[0]?.query;
  if (!o || !r) return { result: { note: 'Qloo returned no demographics for one of the brands.' }, summary: 'No demographics' };

  const row = (key, src) => ({ key, ours: r3(src(o)), rival: r3(src(r)) });
  const withGap = x => ({ ...x, gap: x.ours != null && x.rival != null ? r3(x.rival - x.ours) : null });
  const age = AGE_BUCKETS.map(b => withGap(row(b, q => q.age?.[b])));
  const gender = ['female', 'male'].map(g => withGap(row(g, q => q.gender?.[g])));
  ctx.demographics[rival_id] = { age, gender };

  const widest = [...age].sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0))[0];
  return {
    result: { scale: '-1 to 1, positive means over-indexed', age, gender },
    summary: 'Widest age gap: ' + widest.key.replace(/_/g, ' ') + ' (' + widest.rival + ' vs ' + widest.ours + ')',
  };
}

// ── brand_positioning ─────────────────────────────────────────────────────────

async function brandPositioning(ctx, { brand_id, rival_id }) {
  requirePair(ctx, brand_id, rival_id);
  const d = await qloo.compare(brand_id, rival_id);
  const r = d?.results || {};
  // The same tag name comes back under several subtypes and cases ("Athletes"
  // three times for Nike vs Adidas), and a shared tag can repeat under a or b.
  // Keep each name once per bucket, shared tags best score first, and cap the
  // lists: positioning is a line or two in the brief, not a tag dump.
  const key = t => String(t.name || '').trim().toLowerCase();
  const sharedKeys = new Set();
  const shared = [];
  for (const t of [...(r.tags || [])].sort((x, y) => (y.query?.score || 0) - (x.query?.score || 0))) {
    if (!key(t) || sharedKeys.has(key(t))) continue;
    sharedKeys.add(key(t));
    shared.push({ name: t.name, subtype: t.subtype || null, score: r3(t.query?.score) });
  }
  const only = arr => {
    const seen = new Set(sharedKeys);
    const out = [];
    for (const t of arr || []) {
      if (!key(t) || seen.has(key(t))) continue;
      seen.add(key(t));
      out.push({ name: t.name, subtype: t.subtype || null });
    }
    return out.slice(0, POSITIONING_ONLY_MAX);
  };
  const out = { shared: shared.slice(0, POSITIONING_SHARED_MAX), brand_only: only(r.a), rival_only: only(r.b) };
  ctx.positioning[rival_id] = out;
  return {
    result: out,
    summary: shared.length + ' shared tags, ' + out.brand_only.length + ' only ours, ' + out.rival_only.length + ' only theirs',
  };
}

// ── Definitions ───────────────────────────────────────────────────────────────

const BRAND_PAIR = {
  brand_id: { type: 'string', description: "Our brand's entity_id from search_brands." },
  rival_id: { type: 'string', description: "The rival's entity_id from search_brands." },
};

const TOOL_DEFS = [
  {
    name: 'search_brands',
    description: 'Resolve a brand name to Qloo brand entities. Returns up to 5 candidates with entity_id, name, popularity (0 to 1) and a short description. Call it for our brand and for every rival before using any other tool, and pick the candidate that matches what the user meant.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The brand name as the user wrote it.' } },
      required: ['query'],
    },
  },
  {
    name: 'find_city',
    description: 'Resolve a city name to Qloo localities. Returns up to 5 candidates with locality_id, name and disambiguation. Names repeat across places (New York the state and New York the city), so read the disambiguation and pick the city itself.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The city as the user wrote it.' } },
      required: ['query'],
    },
  },
  {
    name: 'audience_gap',
    description: "Where the rival's audience is that ours is not, in one taste domain. Takes the rival audience's top " + GAP_TAKE + " entities in the domain and scores the same entities for our audience. Affinity runs 0 to 1; gap is rival affinity minus ours, so a large positive gap is rival-owned territory. Also returns mean_gap and strong_gaps (items with a gap of 0.10 or more) for comparing domains. Domains: artist (music), movie, tv_show, brand (other brands) and place (venues, needs locality_id). locality_id is optional for the other domains and scopes the audience to that city.",
    input_schema: {
      type: 'object',
      properties: {
        ...BRAND_PAIR,
        domain: { type: 'string', enum: Object.keys(DOMAINS) },
        locality_id: { type: 'string', description: 'A locality_id from find_city. Required for place.' },
      },
      required: ['brand_id', 'rival_id', 'domain'],
    },
  },
  {
    name: 'geo_gap',
    description: "Where on the map the rival's audience outweighs ours in one city. Joins both brands' Qloo heatmaps cell by cell and returns the " + GEO_HOTSPOTS + ' cells with the widest rival lead (the first ' + GEO_LABELED + ' labelled with a neighborhood and top places), the ' + GEO_OURS_TOP + " cells where we lead most, and the share of cells each side leads. Cells are identified by geohash; cite them by geohash in the brief.",
    input_schema: {
      type: 'object',
      properties: {
        ...BRAND_PAIR,
        locality_id: { type: 'string', description: 'A locality_id from find_city.' },
      },
      required: ['brand_id', 'rival_id', 'locality_id'],
    },
  },
  {
    name: 'demographic_gap',
    description: "Age and gender mix of our audience against the rival's. Scores run -1 to 1, where positive means over-indexed. Age buckets: 24_and_younger, 25_to_29, 30_to_34, 35_to_44, 45_to_54, 55_and_older.",
    input_schema: { type: 'object', properties: BRAND_PAIR, required: ['brand_id', 'rival_id'] },
  },
  {
    name: 'brand_positioning',
    description: "How Qloo tags the two brands themselves: tags they share (with a similarity score) and tags only one side carries. This describes the brands, not their audiences, so use it for positioning only.",
    input_schema: { type: 'object', properties: BRAND_PAIR, required: ['brand_id', 'rival_id'] },
  },
];

const EXECUTORS = {
  search_brands: searchBrands,
  find_city: findCity,
  audience_gap: audienceGap,
  geo_gap: geoGap,
  demographic_gap: demographicGap,
  brand_positioning: brandPositioning,
};

// One line for the live trace, written before the call runs.
function describeCall(ctx, name, input = {}) {
  const brand = entityName(ctx, input.brand_id);
  const rival = entityName(ctx, input.rival_id);
  const city = input.locality_id ? localityName(ctx, input.locality_id) : null;
  switch (name) {
    case 'search_brands': return 'Looking up "' + input.query + '" in Qloo';
    case 'find_city': return 'Finding the city "' + input.query + '"';
    case 'audience_gap': {
      const label = DOMAINS[input.domain]?.label || input.domain;
      return 'Comparing ' + brand + ' and ' + rival + ' audiences in ' + label + (city ? ' in ' + city : '');
    }
    case 'geo_gap': return 'Mapping where ' + rival + "'s audience outweighs " + brand + "'s in " + city;
    case 'demographic_gap': return 'Comparing the age and gender mix of ' + brand + ' and ' + rival + ' audiences';
    case 'brand_positioning': return 'Comparing how Qloo tags ' + brand + ' and ' + rival;
    default: return 'Running ' + name;
  }
}

// Run one tool call. Never throws: a bad input or a Qloo failure comes back as
// an error result so the model can correct itself on the next turn.
async function executeTool(ctx, name, input) {
  const fn = EXECUTORS[name];
  if (!fn) return { ok: false, error: 'Unknown tool ' + name + '.' };
  try {
    const { result, summary } = await fn(ctx, input || {});
    return { ok: true, result, summary };
  } catch (err) {
    return { ok: false, error: err.toolError ? err.message : 'Qloo request failed: ' + err.message };
  }
}

module.exports = {
  TOOL_DEFS, DOMAINS, createContext, executeTool, describeCall, entityName,
};
