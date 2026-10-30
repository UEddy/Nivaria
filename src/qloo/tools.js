// Taste Gap: agent tool definitions over the Qloo client.
//
// Each tool wraps one or more Qloo calls and hands the model a trimmed result.
// The heavier data (images, the full heatmap grid, raw 0 to 1 scores) is kept
// on the run context instead, so the UI can chart it and the agent can attach
// real numbers to the brief without the model restating them.
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
// What the model sees is compact, because the same results are resent on
// every turn and the smallest provider budget (Groq, 8K tokens per minute)
// has to fit a whole run: short refs (b1 for a brand, l1 for a city, e7 for a
// scored entity, c3 for a map cell) instead of UUIDs, rows instead of repeated
// keys, and scores as whole points out of 100. Refs are the only ids the
// model needs: tools take b and l refs as input, and the brief cites e and c
// refs as evidence. Raw Qloo ids are still accepted wherever a ref is.

const qloo = require('./client');
const { sanitizeCopy } = require('../lib/sanitizeText');

// Rival entities scored per domain. 15 gives the model enough to see a cluster
// (several reality fashion shows, not one) at two Qloo calls per domain.
const GAP_TAKE = 15;

// Extra places requested for a city, to refill the list after venues outside
// the city's outline are dropped (1 in 17 for New York).
const PLACE_SPARES = 8;

// Heatmap cells handed to the model, and how many of them get a neighbourhood
// label (one Qloo call each). Cells below GEO_MIN_POPULARITY are thin on
// signal, so they are skipped when enough busier cells exist.
const GEO_HOTSPOTS = 12;
const GEO_LABELED = 8;
const GEO_OURS_TOP = 3;
const GEO_MIN_POPULARITY = 0.4;

// A gap of this much (0 to 1 scale) is "strong", for entities and map cells.
const STRONG_GAP = 0.1;

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

// Whole points out of 100, for what the model reads.
function pts(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) : null;
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
    lead: null,              // follow_lead: { seed, locality, found: domain -> [items], index: entity_id -> item }
    pairBrands: new Set(),   // every brand compared so far, ours and the rivals
    refs: new Map(),         // ref -> { kind, id, rival_id?, geohash? }
    refKeys: new Map(),      // kind + ':' + key -> ref, so one thing keeps one ref
    refCounts: {},
    calls: {},               // Qloo endpoint key -> requests made, for the brief's provenance
  };
}

// The Qloo endpoints the tools call, in the order a run reaches them, for the
// brief's "Qloo endpoints used" row. Cross-scoring is /v2/insights with
// filter.results.entities: the rival audience's top entities, scored for ours.
const ENDPOINTS = [
  { key: 'search', label: 'Search', path: '/search' },
  { key: 'insights', label: 'Insights', path: '/v2/insights' },
  { key: 'cross_scoring', label: 'Cross-scoring', path: '/v2/insights with filter.results.entities' },
  { key: 'heatmap', label: 'Heatmap', path: '/v2/insights, filter.type urn:heatmap' },
  { key: 'demographics', label: 'Demographics', path: '/v2/insights, filter.type urn:demographics' },
  { key: 'compare', label: 'Compare', path: '/v2/analysis/compare' },
];

function counted(ctx, key, n = 1) {
  ctx.calls[key] = (ctx.calls[key] || 0) + n;
}

// The endpoints this run called, each with its request count.
function endpointsUsed(ctx) {
  return ENDPOINTS.filter(e => ctx.calls[e.key]).map(e => ({ ...e, calls: ctx.calls[e.key] }));
}

const REF_PREFIX = { brand: 'b', locality: 'l', entity: 'e', cell: 'c', lead: 'f' };

function makeRef(ctx, kind, key, value) {
  const k = kind + ':' + key;
  if (ctx.refKeys.has(k)) return ctx.refKeys.get(k);
  ctx.refCounts[kind] = (ctx.refCounts[kind] || 0) + 1;
  const ref = REF_PREFIX[kind] + ctx.refCounts[kind];
  ctx.refKeys.set(k, ref);
  ctx.refs.set(ref, { kind, ...value });
  return ref;
}

// A brand ref (b1) or a raw entity_id from search_brands, to the entity_id.
function brandId(ctx, v) {
  const hit = ctx.refs.get(v);
  if (hit && hit.kind === 'brand') return hit.id;
  return ctx.entities.has(v) ? v : null;
}

function localityId(ctx, v) {
  const hit = ctx.refs.get(v);
  if (hit && hit.kind === 'locality') return hit.id;
  return ctx.localities.has(v) ? v : null;
}

function entityName(ctx, v) {
  const id = brandId(ctx, v);
  return (id && ctx.entities.get(id)?.name) || v;
}

function localityName(ctx, v) {
  const id = localityId(ctx, v);
  return (id && ctx.localities.get(id)?.name) || v;
}

function requireBrand(ctx, v, field) {
  const id = brandId(ctx, v);
  if (!id) throw toolError(field + ' must be a brand ref (like b1) from search_brands.');
  return id;
}

function requireLocality(ctx, v) {
  const id = localityId(ctx, v);
  if (!id) throw toolError('locality_id must be a city ref (like l1) from find_city.');
  return id;
}

function requirePair(ctx, input) {
  const b = requireBrand(ctx, input.brand_id, 'brand_id');
  const r = requireBrand(ctx, input.rival_id, 'rival_id');
  if (b === r) throw toolError('brand_id and rival_id must be different brands.');
  ctx.pairBrands.add(b).add(r);
  return [b, r];
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
  counted(ctx, 'search');
  const d = await qloo.search(query.trim(), { types: 'urn:entity:brand', take: 5 });
  const results = (d?.results || []).map(e => {
    const p = e.properties || {};
    ctx.entities.set(e.entity_id, {
      name: e.name, image: p.image?.url || null, type: 'brand', tags: e.tags || [], parent: p.parent_organization || null,
    });
    const desc = p.short_description || '';
    return {
      ref: makeRef(ctx, 'brand', e.entity_id, { id: e.entity_id }),
      name: e.name,
      popularity: pts(e.popularity),
      description: desc.length > 140 ? desc.slice(0, 137) + '...' : desc || null,
      parent: p.parent_organization || null,
    };
  });
  return {
    result: { query, results },
    summary: results.length ? 'Found ' + results.slice(0, 3).map(r => r.name).join(', ') : 'No brands matched',
  };
}

// ── find_city ─────────────────────────────────────────────────────────────────

// Qloo's locality search can rank a region above the city that shares its
// name: "New York" returns the state first and the city second, "Los Angeles"
// the county, "Washington" the state. A heatmap or place query scoped to the
// state lands upstate (Horseheads, Oswego County). So the city is picked here
// from properties.place on each result, not left to the model: when the top
// result is a region and a city of the same name is among the results, the
// city wins. Otherwise Qloo's top result stands, which is right for Brooklyn
// (the borough), Tokyo (the prefecture) and London, Chicago or Lagos (the city).
const REGION_PLACES = new Set(['country', 'state', 'province', 'region', 'county']);
const CITY_PLACES = new Set(['city', 'town', 'village', 'municipality']);

const nameKey = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function pickCity(results) {
  const top = results[0];
  if (!top) return { city: null, passedOver: null };
  const topPlace = top.properties?.place;
  if (!REGION_PLACES.has(topPlace)) return { city: top, passedOver: null };
  const city = results.find(e => CITY_PLACES.has(e.properties?.place) && nameKey(e.name) === nameKey(top.name));
  return city ? { city, passedOver: topPlace } : { city: top, passedOver: null };
}

// The city's outline from the same /search result (properties.boundaries,
// WKT POLYGON or MULTIPOLYGON) as rings of [lng, lat]. Null when it has none.
function parseBoundary(wkt) {
  if (typeof wkt !== 'string' || !/^\s*(MULTI)?POLYGON/i.test(wkt)) return null;
  const rings = [...wkt.matchAll(/\(([^()]+)\)/g)]
    .map(m => m[1].split(',').map(pt => pt.trim().split(/\s+/).map(Number)))
    .filter(r => r.length >= 3);
  return rings.length ? rings : null;
}

// Even-odd test over every ring, so holes and a multipolygon's separate
// islands (Staten Island, Manhattan) both come out right.
function insideBoundary(rings, lat, lng) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// A place with no coordinates is kept: only a known location outside the
// outline drops it.
function inBoundary(rings, e) {
  return !rings || e.location?.lat == null || e.location?.lon == null || insideBoundary(rings, e.location.lat, e.location.lon);
}

async function findCity(ctx, { query }) {
  if (!query || typeof query !== 'string') throw toolError('query is required.');
  counted(ctx, 'search');
  const d = await qloo.search(query.trim(), { types: 'urn:entity:locality', take: 5 });
  const { city, passedOver } = pickCity(d?.results || []);
  if (!city) return { result: { query, city: null, note: 'Qloo found no city by that name.' }, summary: 'No cities matched' };

  const p = city.properties || {};
  const disambiguation = city.disambiguation || city.name;
  ctx.localities.set(city.entity_id, { name: city.name, disambiguation, place: p.place || null, boundary: parseBoundary(p.boundaries) });
  const result = {
    query,
    city: {
      ref: makeRef(ctx, 'locality', city.entity_id, { id: city.entity_id }),
      name: city.name,
      disambiguation,
      type: p.place || null,
      population: typeof p.population === 'number' && p.population > 0 ? p.population : null,
    },
  };
  if (passedOver) result.note = 'Using the city, not the ' + passedOver + ' with the same name.';
  return {
    result,
    summary: 'Using ' + disambiguation + (passedOver ? ' (the city, not the ' + passedOver + ')' : ''),
  };
}

// ── audience_gap ──────────────────────────────────────────────────────────────

async function audienceGap(ctx, input) {
  const [brand, rival] = requirePair(ctx, input);
  const { domain } = input;
  const cfg = DOMAINS[domain];
  if (!cfg) throw toolError('domain must be one of: ' + Object.keys(DOMAINS).join(', ') + '.');
  if (domain === 'place' && !input.locality_id) throw toolError('The place domain needs a locality_id from find_city.');
  const locality = input.locality_id ? requireLocality(ctx, input.locality_id) : null;
  const loc = locality ? { 'filter.location': locality } : {};

  // filter.location scopes places to the city loosely: for New York it still
  // returns venues across the Hudson in Hoboken. Places outside the city's
  // outline from find_city are dropped, so the place domain asks for spares.
  // Two extra cover the brand and rival themselves in the brand domain.
  const boundary = domain === 'place' ? ctx.localities.get(locality)?.boundary : null;
  counted(ctx, 'insights');
  const rivalTop = await qloo.insights(cfg.type, {
    'signal.interests.entities': rival, take: GAP_TAKE + (boundary ? PLACE_SPARES : 2), ...loc,
  });
  const exclude = new Set([brand, rival]);
  const top = entitiesOf(rivalTop).filter(e => !exclude.has(e.entity_id) && inBoundary(boundary, e)).slice(0, GAP_TAKE);
  if (!top.length) {
    return { result: { domain, rows: [], note: 'Qloo returned no ' + cfg.label + ' for this rival.' }, summary: 'No results' };
  }

  const ids = top.map(e => e.entity_id);
  counted(ctx, 'cross_scoring');
  const cross = await qloo.insights(cfg.type, {
    'signal.interests.entities': brand, 'filter.results.entities': ids, take: ids.length, ...loc,
  });
  const ours = new Map(entitiesOf(cross).map(e => [e.entity_id, e.query?.affinity]));

  const items = top.map(e => {
    const rivalAff = r3(e.query?.affinity);
    const ourAff = r3(ours.get(e.entity_id));
    const item = {
      ref: makeRef(ctx, 'entity', rival + ':' + e.entity_id, { id: e.entity_id, rival_id: rival }),
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
  ctx.gaps[rival] = ctx.gaps[rival] || {};
  ctx.gaps[rival][domain] = items;
  for (const it of items) ctx.gapIndex.set(rival + ':' + it.entity_id, it);

  const scored = items.filter(it => it.gap != null);
  const mean = scored.length ? scored.reduce((s, it) => s + it.gap, 0) / scored.length : null;
  const lead = scored[0];
  const columns = ['ref', 'name', 'rival', 'ours', 'gap', 'tags'];
  if (domain === 'place') columns.push('neighborhood');

  return {
    result: {
      domain,
      city: locality ? localityName(ctx, locality) : null,
      mean_gap: pts(mean),
      strong_gaps: scored.filter(it => it.gap >= STRONG_GAP).length,
      columns,
      rows: items.map(it => {
        const row = [it.ref, it.name, pts(it.rival_affinity), pts(it.our_affinity), pts(it.gap), it.descriptors.join(', ')];
        if (domain === 'place') row.push(it.neighborhood);
        return row;
      }),
    },
    summary: lead
      ? 'Biggest gap: ' + lead.name + ' (' + pts(lead.rival_affinity) + ' vs ' + pts(lead.our_affinity) + '), mean gap ' + pts(mean) + (Math.abs(pts(mean)) === 1 ? ' point' : ' points')
      : 'No overlap scored',
  };
}

// ── geo_gap ───────────────────────────────────────────────────────────────────

// The neighbourhood a cell sits in, read off the top places Qloo returns for
// that geohash. Many places carry no neighbourhood name but all carry the
// borough or county (geocode.admin2_region), so the label is "neighbourhood,
// borough" when both are known and whichever one is known otherwise.
// Best-effort: a failed lookup leaves the cell unlabelled.
function mostCommon(values) {
  const counts = {};
  for (const v of values) if (v) counts[v] = (counts[v] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// Four of New York City's boroughs come back as their county names. Keyed by
// state too, since Kings, Queens and Richmond counties exist elsewhere.
const NYC_BOROUGHS = {
  'New York County': 'Manhattan',
  'Kings County': 'Brooklyn',
  'Queens County': 'Queens',
  'Bronx County': 'The Bronx',
  'Richmond County': 'Staten Island',
};

function areaName(geocode) {
  const area = geocode?.admin2_region || null;
  return (geocode?.admin1_region === 'New York' && NYC_BOROUGHS[area]) || area;
}

function placeLabel(neighborhood, area) {
  if (neighborhood && area && nameKey(neighborhood) !== nameKey(area)) return neighborhood + ', ' + area;
  return neighborhood || area || null;
}

async function labelCell(ctx, cell, signalId) {
  counted(ctx, 'insights');
  try {
    const d = await qloo.insights('urn:entity:place', {
      'signal.interests.entities': signalId, 'filter.location.geohash': cell.geohash, take: 3,
    });
    const places = entitiesOf(d);
    cell.neighborhood = mostCommon(places.map(p => p.properties?.geocode?.name));
    cell.area = mostCommon(places.map(p => areaName(p.properties?.geocode)));
    cell.label = placeLabel(cell.neighborhood, cell.area);
    cell.top_places = places.map(p => p.name).slice(0, 3);
  } catch (_) {
    cell.neighborhood = null;
    cell.area = null;
    cell.label = null;
    cell.top_places = [];
  }
}

async function geoGap(ctx, input) {
  const [brand, rival] = requirePair(ctx, input);
  const locality = requireLocality(ctx, input.locality_id);

  counted(ctx, 'heatmap', 2);
  const [mine, theirs] = await Promise.all([brand, rival].map(id =>
    qloo.insights('urn:heatmap', { 'signal.interests.entities': id, 'filter.location': locality })));
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
    ...hotspots.slice(0, GEO_LABELED).map(c => labelCell(ctx, c, rival)),
    ...ourStrongest.map(c => labelCell(ctx, c, brand)),
  ]);
  for (const c of [...hotspots, ...ourStrongest]) {
    c.ref = makeRef(ctx, 'cell', rival + ':' + c.geohash, { geohash: c.geohash, rival_id: rival });
  }

  const sortedGaps = cells.map(c => c.gap).sort((a, b) => a - b);
  const stats = {
    cells_compared: cells.length,
    median_gap: sortedGaps[Math.floor(sortedGaps.length / 2)],
    share_rival_leads: r3(cells.filter(c => c.gap >= STRONG_GAP).length / cells.length),
    share_we_lead: r3(cells.filter(c => c.gap <= -STRONG_GAP).length / cells.length),
  };
  ctx.geo[rival] = {
    locality: { locality_id: locality, name: localityName(ctx, locality) },
    cells, hotspots, our_strongest: ourStrongest, stats,
  };

  const row = c => [c.ref, c.label || null, (c.top_places || []).join(', '),
    pts(c.rival_affinity), pts(c.our_affinity), pts(c.gap)];
  const top = hotspots[0];
  return {
    result: {
      city: localityName(ctx, locality),
      cells_compared: stats.cells_compared,
      median_gap: pts(stats.median_gap),
      rival_leads_pct: pts(stats.share_rival_leads),
      we_lead_pct: pts(stats.share_we_lead),
      columns: ['ref', 'place', 'top_places', 'rival', 'ours', 'gap'],
      rival_hotspots: hotspots.map(row),
      our_strongest: ourStrongest.map(row),
    },
    // An unlabelled cell is only a geohash, which means nothing on screen.
    summary: 'Rival leads by ' + pts(STRONG_GAP) + ' or more in ' + pts(stats.share_rival_leads) + '% of ' + cells.length
      + ' cells; widest gap' + (top.label ? ' in ' + top.label : '') + ' (' + pts(top.rival_affinity) + ' vs ' + pts(top.our_affinity) + ')',
  };
}

// ── demographic_gap ───────────────────────────────────────────────────────────

async function demographicGap(ctx, input) {
  const [brand, rival] = requirePair(ctx, input);
  counted(ctx, 'demographics', 2);
  const [mine, theirs] = await Promise.all([brand, rival].map(id =>
    qloo.insights('urn:demographics', { 'signal.interests.entities': id })));
  const o = mine?.results?.demographics?.[0]?.query;
  const r = theirs?.results?.demographics?.[0]?.query;
  if (!o || !r) return { result: { note: 'Qloo returned no demographics for one of the brands.' }, summary: 'No demographics' };

  const row = (key, src) => ({ key, ours: r3(src(o)), rival: r3(src(r)) });
  const withGap = x => ({ ...x, gap: x.ours != null && x.rival != null ? r3(x.rival - x.ours) : null });
  const age = AGE_BUCKETS.map(b => withGap(row(b, q => q.age?.[b])));
  const gender = ['female', 'male'].map(g => withGap(row(g, q => q.gender?.[g])));
  ctx.demographics[rival] = { age, gender };

  const asRow = x => [x.key, pts(x.ours), pts(x.rival), pts(x.gap)];
  const widest = [...age].sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0))[0];
  return {
    result: {
      scale: '-100 to 100, positive means over-indexed',
      columns: ['group', 'ours', 'rival', 'gap'],
      age: age.map(asRow),
      gender: gender.map(asRow),
    },
    summary: 'Widest age gap: ' + widest.key.replace(/_/g, ' ') + ' (' + pts(widest.rival) + ' vs ' + pts(widest.ours) + ')',
  };
}

// ── brand_positioning ─────────────────────────────────────────────────────────

async function brandPositioning(ctx, input) {
  const [brand, rival] = requirePair(ctx, input);
  counted(ctx, 'compare');
  const d = await qloo.compare(brand, rival);
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
  ctx.positioning[rival] = out;
  return {
    result: {
      shared: out.shared.map(t => t.name + ' (' + pts(t.score) + ')'),
      ours_only: out.brand_only.map(t => t.name),
      rival_only: out.rival_only.map(t => t.name),
    },
    summary: out.shared.length + ' shared tags, ' + out.brand_only.length + ' only ours, ' + out.rival_only.length + ' only theirs',
  };
}

// ── follow_lead ───────────────────────────────────────────────────────────────
// One entity from an audience gap (a country act the rival's fans love, say)
// becomes the signal itself: what that entity's own fans also over-index on
// in music, places, brands and TV, one Insights call per domain, in parallel.
// Places are scoped to the run's city and its outline, and skipped without
// one. It runs once per brief, so the top win-first hook rests on a chain of
// tastes rather than one title. Rows get f refs, which the brief cites like
// any other evidence; the server attaches these numbers.

const LEAD_DOMAINS = ['artist', 'place', 'brand', 'tv_show'];
const LEAD_TAKE = 5;
const LEAD_WORDS = { artist: 'music', place: 'places', brand: 'brands', tv_show: 'TV' };

// The audience_gap item an e ref names, with the rival it was scored for.
function gapItem(ctx, ref) {
  const hit = ctx.refs.get(ref);
  if (!hit || hit.kind !== 'entity') return null;
  const item = ctx.gapIndex.get(hit.rival_id + ':' + hit.id);
  return item ? { ...item, rival_id: hit.rival_id } : null;
}

// The city for places: the one given, else the run's only city.
function leadLocality(ctx, input) {
  if (input.locality_id) return requireLocality(ctx, input.locality_id);
  return ctx.localities.size === 1 ? [...ctx.localities.keys()][0] : null;
}

const leadDomains = locality => LEAD_DOMAINS.filter(d => d !== 'place' || locality);

const listWords = words => (words.length < 3 ? words.join(' and ') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1]);

async function followLead(ctx, input) {
  if (ctx.lead) throw toolError('follow_lead runs once per brief and already ran on ' + ctx.lead.seed.name + '. Use what it returned.');
  const seed = gapItem(ctx, input.entity_ref);
  if (!seed) throw toolError('entity_ref must be an entity ref (like e3) from an audience_gap row.');
  const locality = leadLocality(ctx, input);
  const boundary = locality ? ctx.localities.get(locality)?.boundary : null;
  const domains = leadDomains(locality);
  const skip = new Set([seed.entity_id, ...ctx.pairBrands]);

  counted(ctx, 'insights', domains.length);
  const lists = await Promise.all(domains.map(domain => qloo.insights(DOMAINS[domain].type, {
    'signal.interests.entities': seed.entity_id,
    take: LEAD_TAKE + 2 + (domain === 'place' && boundary ? PLACE_SPARES : 0),
    ...(domain === 'place' ? { 'filter.location': locality } : {}),
  }).then(entitiesOf, () => null)));

  const found = {};
  const index = new Map();
  domains.forEach((domain, i) => {
    if (!lists[i]) return;
    found[domain] = lists[i]
      .filter(e => !skip.has(e.entity_id) && (domain !== 'place' || inBoundary(boundary, e)))
      .slice(0, LEAD_TAKE)
      .map(e => {
        const item = {
          ref: makeRef(ctx, 'lead', e.entity_id, { id: e.entity_id }),
          entity_id: e.entity_id,
          name: e.name,
          domain,
          affinity: r3(e.query?.affinity),
          popularity: r3(e.popularity),
          descriptors: descriptors(e),
          image: e.properties?.image?.url || null,
        };
        if (domain === 'place') item.neighborhood = e.properties?.geocode?.name || null;
        index.set(e.entity_id, item);
        return item;
      });
  });
  if (!index.size) throw toolError('Qloo returned nothing for fans of ' + seed.name + '.');

  ctx.lead = {
    seed: {
      ref: input.entity_ref, entity_id: seed.entity_id, name: seed.name, domain: seed.domain, rival_id: seed.rival_id,
      rival_affinity: seed.rival_affinity, our_affinity: seed.our_affinity, gap: seed.gap,
    },
    locality: locality ? { locality_id: locality, name: localityName(ctx, locality) } : null,
    found,
    index,
  };

  const rows = {};
  for (const [domain, items] of Object.entries(found)) {
    rows[LEAD_WORDS[domain]] = items.map(it => [it.ref, it.name, pts(it.affinity), domain === 'place' ? it.neighborhood : it.descriptors.join(', ')]);
  }
  const tops = Object.values(found).map(items => items[0]?.name).filter(Boolean);
  return {
    result: {
      lead: seed.name,
      lead_gap: pts(seed.gap),
      city: locality ? localityName(ctx, locality) : null,
      note: 'Affinity 0 to 100: how strongly fans of ' + seed.name + ' over-index on each. Build the rank 1 win_first hook on these, and cite their refs (like f2) in its evidence.',
      columns: ['ref', 'name', 'affinity', 'tags'],
      ...rows,
    },
    summary: 'Fans of ' + seed.name + ' also over-index on ' + listWords(tops),
  };
}

// ── Definitions ───────────────────────────────────────────────────────────────

const BRAND_PAIR = {
  brand_id: { type: 'string', description: "Our brand's ref from search_brands, like b1." },
  rival_id: { type: 'string', description: "The rival's ref from search_brands, like b2." },
};

// ── discover_rivals ───────────────────────────────────────────────────────────
// Rival discovery, for a run where the user named no rival. Two Insights calls
// with our brand as signal.interests.entities and filter.type
// urn:entity:brand: the brands our audience over-indexes on most (audience
// overlap), and the same list filtered by our brand's most specific category
// tag, which brings in same-category rivals the overlap list misses (Peet's
// Coffee for Starbucks). Affinity means the same in both, so the lists merge.
//
// Candidates are ranked by the category tags they share with our brand, then
// by affinity. Only tags that say what a brand is count (Qloo genre, industry
// and product category tags, and Wikipedia categories), and of those only
// specific ones: "Coffee & Tea", "Skincare" or "Coffee houses of the United
// States" count, while "Retail", "Food & Beverage", top-level genres, app
// store genres and company facts ("Companies listed on the Nasdaq") do not.
//
// Flags mark what is not a competitor: another brand of the same family, the
// parent company, a brand with the same owner or one we own, or a retailer.
// "Retailer" means a store chain or marketplace that sells other brands, read
// from store-format tags (Supermarket Chain, Grocery, Pharmacy, Department
// stores, Marketplace) or the name (Sephora, Ulta, Target, Walmart, Amazon,
// and a few more).
// It never comes from a generic tag such as Retail, or from Qloo's
// distribution_channel tags, which say where a product is sold (Oreo's
// "Supermarkets"), not what the brand is. The model chooses; choose_rivals
// checks the choice.

const DISCOVER_TAKE = 20;
const CATEGORY_TAKE = 12;
const DISCOVER_SHOWN = 12;

const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// "Body Care" and "Bodycare" are one tag.
const tagKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const GENRE = 'urn:tag:genre:brand';
const CATEGORY_TYPES = new Set([GENRE, 'urn:tag:industry:qloo', 'urn:tag:product_category:qloo', 'urn:tag:wikipedia_category']);
const GENERIC_TAGS = new Set([
  'retail', 'other', 'b2c', 'b2b', 'everyday', 'global travel', 'lifestyle', 'dining', 'mobile app', 'website', 'software',
  'food & beverage', 'health & beauty', 'beauty & personal care', 'health & wellness', 'fashion', 'fashion & apparel',
  'consumer packaged goods', 'cpg', 'media & entertainment', 'technology', 'general merchandise', 'personal goods',
].map(tagKey));
// App store genres describe the app, not the category (McDonald's and
// Starbucks are both "Food & Dining App").
const APP_GENRES = new Set(['mobile_app', 'website', 'software']);
// Wikipedia categories about the company rather than what it sells.
const CORPORATE_WIKI = /\b(?:compan(?:y|ies)|establish\w*|disestablish\w*|listed|nasdaq|stock exchange|dow jones|multinational|headquartered|based in|history of|culture of|spin-offs?|mergers|acquisitions|bankruptcy|stubs?|errors|centric|\d{4}s?)\b/i;

// The path under urn:tag:genre:brand, e.g. ['food_and_beverage', 'drinks', 'coffee_and_tea'].
// Search results carry tag_id, insights results id.
const genrePath = t => String(t.tag_id || t.id || '').replace(/^urn:tag:genre:brand:?/, '').split(':').filter(Boolean);

function isGenericTag(t) {
  const name = String(t.name || '').trim();
  if (!name || GENERIC_TAGS.has(tagKey(name))) return true;
  if (t.type === GENRE) {
    const path = genrePath(t);
    return path.length < 2 || APP_GENRES.has(path[0]);
  }
  return t.type === 'urn:tag:wikipedia_category' && CORPORATE_WIKI.test(name);
}

// The specific category tags on an entity, once each by name, with the genre
// path for genre tags.
function categoryTags(e) {
  const out = [];
  for (const t of e.tags || []) {
    if (!CATEGORY_TYPES.has(t.type) || isGenericTag(t)) continue;
    const name = String(t.name).trim();
    if (!out.some(x => tagKey(x.name) === tagKey(name))) out.push({ name, path: t.type === GENRE ? genrePath(t) : null });
  }
  return out;
}

// The category tags a candidate shares with our brand. Genre tags nest, so a
// sunscreen brand carries both Skincare and Suncare and a coffee chain both
// Drinks and Coffee & Tea: tags on one branch count once, as the deepest.
function sharedTags(theirs, ourKeys) {
  const shared = theirs.filter(t => ourKeys.has(tagKey(t.name)));
  const under = (a, b) => b.path && a.path && b.path.length > a.path.length && a.path.every((seg, i) => b.path[i] === seg);
  return shared.filter(t => !shared.some(o => under(t, o))).map(t => t.name);
}

// Our brand's most specific category tag for the filtered query: its deepest
// genre tag outside the app store genres (Coffee & Tea for Starbucks, Running
// for Nike). A top-level genre (Health & Beauty for Fenty Beauty) is used when
// it is all the brand has.
function filterTag(tags) {
  let best = null;
  for (const t of tags || []) {
    if (t.type !== GENRE || !(t.tag_id || t.id)) continue;
    const path = genrePath(t);
    if (!path.length || APP_GENRES.has(path[0])) continue;
    if (!best || path.length > best.depth) best = { id: t.tag_id || t.id, name: String(t.name || '').trim(), depth: path.length };
  }
  return best;
}

// Multi-brand chains whose Qloo tags carry no store format, only the generic
// Retail (Foot Locker, Dick's).
const RETAILER_NAMES = new Set(['sephora', 'ulta', 'ulta beauty', 'target', 'walmart', 'amazon', 'amazon com',
  'foot locker', 'dick s sporting goods', 'best buy', 'kohl s', 'macy s']);
const STORE_FORMAT = /\b(?:supermarkets?|supermarket chain|hypermarkets?|grocery|grocers?|convenience stores?|pharmac(?:y|ies)|drugstores?|drug stores?|department stores?|discount stores?|superstores?|warehouse clubs?|marketplaces?|personal care retail)\b/i;
const STORE_TYPES = new Set([GENRE, 'urn:tag:industry:qloo', 'urn:tag:business_model:qloo', 'urn:tag:wikipedia_category']);

function isRetailer(name, tags) {
  if (RETAILER_NAMES.has(normName(name))) return true;
  const of = type => (tags || []).filter(t => t.type === type).map(t => String(t.name || ''));
  const brandType = of('urn:tag:brand_type:qloo');
  // A product brand's store tags say where it is sold (Fuze Tea's industry
  // "Grocery & Convenience Stores"); a store chain is never a product brand.
  if (!brandType.some(n => /^product brand$/i.test(n))
    && (tags || []).some(t => STORE_TYPES.has(t.type) && STORE_FORMAT.test(String(t.name || '')))) return true;
  // An online store: e-commerce as its industry and a retail brand by type
  // (Revolve, Soko Glam), not a brand that also sells online (Eggie).
  return of('urn:tag:industry:qloo').some(n => /^e-?commerce$/i.test(n)) && brandType.some(n => /^retail brand$/i.test(n));
}

async function discoverRivals(ctx, input) {
  const brand = requireBrand(ctx, input.brand_id, 'brand_id');
  const own = ctx.entities.get(brand) || {};
  const ownName = normName(own.name);
  // A Wikipedia category named after our brand ("Starbucks") marks its own
  // family, not a category.
  const ownKeys = new Set(categoryTags({ tags: own.tags }).map(t => tagKey(t.name)).filter(k => k !== tagKey(own.name)));
  const owned = new Set((own.tags || []).filter(t => t.type === 'urn:tag:subsidiary:qloo').map(t => normName(t.name)));
  // A retailer's rivals are other retailers, so the flag only applies when our
  // brand is not one.
  const flagRetail = !isRetailer(own.name, own.tags);
  const category = filterTag(own.tags);

  counted(ctx, 'insights', category ? 2 : 1);
  const [overlap, sameCategory] = await Promise.all([
    qloo.insights('urn:entity:brand', { 'signal.interests.entities': brand, take: DISCOVER_TAKE }),
    category
      ? qloo.insights('urn:entity:brand', { 'signal.interests.entities': brand, 'filter.tags': category.id, take: CATEGORY_TAKE }).catch(() => null)
      : null,
  ]);

  const pool = new Map();
  for (const [list, source] of [[entitiesOf(overlap), 'overlap'], [entitiesOf(sameCategory), 'category']]) {
    for (const e of list) {
      if (e.entity_id === brand) continue;
      const seen = pool.get(e.entity_id);
      if (seen) { seen.sources.add(source); continue; }
      pool.set(e.entity_id, { e, sources: new Set([source]) });
    }
  }

  // Whole words only: "dunkin" is in "dunkin donuts", but "h m" is not in "smith motors".
  const within = (a, b) => (' ' + b + ' ').includes(' ' + a + ' ');
  const ranked = [...pool.values()].map(({ e, sources }) => {
    const p = e.properties || {};
    const name = normName(e.name);
    const flags = [];
    if (ownName && name && (within(ownName, name) || within(name, ownName))) flags.push('same brand family');
    if (own.parent && normName(own.parent) === name) flags.push('parent company');
    if (p.parent_organization && own.parent && normName(p.parent_organization) === normName(own.parent)) flags.push('same parent company');
    if ((p.parent_organization && normName(p.parent_organization) === ownName) || owned.has(name)) flags.push('owned by ' + own.name);
    if (flagRetail && isRetailer(e.name, e.tags)) flags.push('retailer');
    return {
      e,
      entity_id: e.entity_id,
      name: e.name,
      affinity: pts(e.query?.affinity),
      popularity: pts(e.popularity),
      shared_tags: sharedTags(categoryTags(e), ownKeys),
      category: descriptors(e),
      parent: p.parent_organization || null,
      found_by: sources.size > 1 ? 'both' : [...sources][0],
      flags,
    };
  }).sort((a, b) => (b.shared_tags.length - a.shared_tags.length) || ((b.affinity ?? -1) - (a.affinity ?? -1)));

  const candidates = ranked.slice(0, DISCOVER_SHOWN).map(({ e, ...c }) => {
    const p = e.properties || {};
    ctx.entities.set(e.entity_id, { name: e.name, image: p.image?.url || null, type: 'brand', tags: e.tags || [], parent: c.parent });
    return { ref: makeRef(ctx, 'brand', e.entity_id, { id: e.entity_id }), ...c };
  });
  ctx.discovery = { brand_id: brand, candidates, category: category?.name || null };
  if (!candidates.length) {
    return { result: { brand: own.name, rows: [], note: 'Qloo returned no overlapping brands.' }, summary: 'No overlapping brands found' };
  }
  const top = candidates.find(c => !c.flags.length);
  return {
    result: {
      brand: own.name,
      category: category?.name || null,
      note: 'Ranked by shared_tags (the specific category tags this brand shares with ours), then affinity. found_by: overlap (our audience over-indexes on it), category (from the pass filtered to our category tag), or both. flags mark what is not a competitor.',
      columns: ['ref', 'name', 'affinity', 'popularity', 'shared_tags', 'category', 'found_by', 'flags'],
      rows: candidates.map(c => [c.ref, c.name, c.affinity, c.popularity, c.shared_tags.slice(0, 5).join(', '), c.category.join(', '), c.found_by, c.flags.join(', ') || null]),
    },
    summary: 'Ranked ' + candidates.length + ' brands by the category tags they share with ' + own.name
      + (category ? ', including a pass filtered to ' + category.name : '')
      + (top ? '. Closest: ' + top.name + (top.shared_tags.length ? ' (' + top.shared_tags.slice(0, 3).join(', ') + ')' : '') : ''),
  };
}

// ── choose_rivals ─────────────────────────────────────────────────────────────
// The model's choice of one or two rivals from discover_rivals, with its
// reason. Checked here: every pick must be a candidate and not our brand, a
// flagged candidate is refused while an unflagged one exists, and so is one
// that shares no category tag with us while an unflagged one does.

function chooseRivals(ctx, input) {
  if (!ctx.discovery) throw toolError('Call discover_rivals first.');
  const refs = Array.isArray(input.rival_ids) ? input.rival_ids : [];
  if (refs.length < 1 || refs.length > 2) throw toolError('Choose one or two rivals.');
  const clean = ctx.discovery.candidates.filter(x => !x.flags.length);
  const picked = [];
  for (const ref of refs) {
    const id = brandId(ctx, ref);
    if (id === ctx.discovery.brand_id) throw toolError(ref + ' is our own brand.');
    const c = ctx.discovery.candidates.find(x => x.entity_id === id);
    if (!c) throw toolError(ref + ' is not one of the discover_rivals candidates.');
    if (c.flags.length && clean.length) throw toolError(c.name + ' is flagged (' + c.flags.join(', ') + '), so it is not a competitor. Choose an unflagged candidate.');
    if (!c.shared_tags.length && clean.some(x => x.shared_tags.length)) throw toolError(c.name + ' shares no category tag with our brand. Choose a candidate in the same category.');
    if (!picked.includes(c)) picked.push(c);
  }
  const reason = sanitizeCopy(String(input.reason || '').trim()).slice(0, 400);
  if (!reason) throw toolError('Give the reason in one sentence.');
  ctx.rivalChoice = { picked: picked.map(c => c.entity_id), reason };
  return {
    result: { chosen: picked.map(c => ({ ref: c.ref, name: c.name })), next: 'Run the brief with these refs as the rivals.' },
    summary: reason,
  };
}

const TOOL_DEFS = [
  {
    name: 'search_brands',
    description: 'Resolve a brand name to Qloo brands. Returns up to 5 candidates, each with a ref (like b1), name, popularity (0 to 100) and description. Call it for our brand and every rival first, pick the candidate the user meant, and pass its ref to the other tools.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The brand name as the user wrote it.' } },
      required: ['query'],
    },
  },
  {
    name: 'find_city',
    description: 'Resolve a city name to the Qloo city to use. Returns one city with a ref (like l1), name, disambiguation and type. Where a state or county shares the name (New York, Los Angeles), the city itself is already chosen. Pass its ref as locality_id to audience_gap and geo_gap.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The city as the user wrote it.' } },
      required: ['query'],
    },
  },
  {
    name: 'audience_gap',
    description: "Where the rival's audience is that ours is not, in one taste domain. Scores the rival audience's top " + GAP_TAKE + " entities in the domain for both audiences. Rows are [ref, name, rival, ours, gap, tags]: affinity 0 to 100, gap = rival minus ours, so a large positive gap is rival-owned territory. Also returns mean_gap and strong_gaps (rows with a gap of 10 or more) for comparing domains. Domains: artist (music), movie, tv_show, brand (other brands), place (venues, needs locality_id). locality_id is optional elsewhere and scopes the audience to that city.",
    input_schema: {
      type: 'object',
      properties: {
        ...BRAND_PAIR,
        domain: { type: 'string', enum: Object.keys(DOMAINS) },
        locality_id: { type: 'string', description: 'A city ref from find_city, like l2. Required for place.' },
      },
      required: ['brand_id', 'rival_id', 'domain'],
    },
  },
  {
    name: 'geo_gap',
    description: "Where on the map the rival's audience outweighs ours in one city. Joins both brands' Qloo heatmaps cell by cell. Returns the " + GEO_HOTSPOTS + ' cells with the widest rival lead (the first ' + GEO_LABELED + ' labelled with their place, such as "Charleston, Staten Island", and top places), the ' + GEO_OURS_TOP + ' cells where we lead most, and the percentage of cells each side leads by 10 or more. Rows are [ref, place, top_places, rival, ours, gap] on a 0 to 100 scale.',
    input_schema: {
      type: 'object',
      properties: {
        ...BRAND_PAIR,
        locality_id: { type: 'string', description: 'A city ref from find_city, like l2.' },
      },
      required: ['brand_id', 'rival_id', 'locality_id'],
    },
  },
  {
    name: 'demographic_gap',
    description: "Age and gender mix of our audience against the rival's. Rows are [group, ours, rival, gap] on a -100 to 100 scale, where positive means over-indexed.",
    input_schema: { type: 'object', properties: BRAND_PAIR, required: ['brand_id', 'rival_id'] },
  },
  {
    name: 'brand_positioning',
    description: 'How Qloo tags the two brands themselves: tags they share (with a similarity score) and tags only one side carries. This describes the brands, not their audiences, so use it for positioning only.',
    input_schema: { type: 'object', properties: BRAND_PAIR, required: ['brand_id', 'rival_id'] },
  },
  {
    name: 'follow_lead',
    description: "Follow one lead. Takes a single entity from an audience_gap row (the strongest gap, such as an artist the rival's fans love) and returns what that entity's own fans also over-index on in music, places (in the city), brands and TV, from Qloo insights with the entity as the signal. Rows are [ref, name, affinity, tags] with affinity 0 to 100; place rows carry the neighborhood in place of tags. Call it once per brief.",
    input_schema: {
      type: 'object',
      properties: {
        entity_ref: { type: 'string', description: 'An entity ref from an audience_gap row, like e3.' },
        locality_id: { type: 'string', description: "A city ref from find_city, like l1, for places. Defaults to the run's city." },
      },
      required: ['entity_ref'],
    },
  },
];

// Offered only when the user named no rival (see runTasteAgent).
const DISCOVERY_DEFS = [
  {
    name: 'discover_rivals',
    description: "Find rival candidates when the user named none. Qloo insights with our brand as the signal, twice: the brands our audience over-indexes on, and the same filtered to our brand's most specific category tag. Lists up to " + DISCOVER_SHOWN + " brands ranked by the specific category tags they share with ours (such as Coffee & Tea or Skincare), then affinity. Rows are [ref, name, affinity, popularity, shared_tags, category, found_by, flags]: affinity and popularity 0 to 100, found_by overlap, category or both, flags what makes it not a competitor (same brand family, parent company, same parent company, owned by our brand, retailer). The refs work as rival ids everywhere.",
    input_schema: {
      type: 'object',
      properties: { brand_id: { type: 'string', description: "Our brand's ref from search_brands, like b1." } },
      required: ['brand_id'],
    },
  },
  {
    name: 'choose_rivals',
    description: 'Record which one or two discover_rivals candidates to compare against, and why in one sentence that cites the affinity and shared tags discover_rivals returned. Call it once, after discover_rivals and before any comparison.',
    input_schema: {
      type: 'object',
      properties: {
        rival_ids: { type: 'array', items: { type: 'string' }, description: 'One or two candidate refs, like b4.' },
        reason: { type: 'string', description: 'One sentence citing the Qloo numbers.' },
      },
      required: ['rival_ids', 'reason'],
    },
  },
];

const EXECUTORS = {
  discover_rivals: discoverRivals,
  choose_rivals: chooseRivals,
  search_brands: searchBrands,
  find_city: findCity,
  audience_gap: audienceGap,
  geo_gap: geoGap,
  demographic_gap: demographicGap,
  brand_positioning: brandPositioning,
  follow_lead: followLead,
};

// One sentence for the trace, written before the call runs, naming the Qloo
// endpoint the tool calls.
const DOMAIN_PLURAL = { artist: 'artists', movie: 'films', tv_show: 'TV shows', place: 'places', brand: 'brands' };

function describeCall(ctx, name, input = {}) {
  const brand = entityName(ctx, input.brand_id);
  const rival = entityName(ctx, input.rival_id);
  const city = input.locality_id ? localityName(ctx, input.locality_id) : null;
  switch (name) {
    case 'search_brands': return 'Looking up the brand "' + input.query + '" with Qloo search';
    case 'discover_rivals': return 'Finding the brands whose audiences overlap most with ' + brand + ' with Qloo insights';
    case 'choose_rivals': {
      const names = (input.rival_ids || []).map(r => entityName(ctx, r));
      return 'Choosing the rivals: ' + (names.length ? names.join(' and ') : 'none named');
    }
    case 'find_city': return 'Finding the city "' + input.query + '" with Qloo search';
    case 'audience_gap': {
      const what = DOMAIN_PLURAL[input.domain] || input.domain;
      return 'Pulling the top ' + what + ' for ' + rival + ' fans with Qloo insights, then cross-scoring them for ' + brand + ' fans' + (city ? ' in ' + city : '');
    }
    case 'geo_gap': return 'Mapping both audiences across ' + city + ' with Qloo heatmaps, then naming the hotspots with Qloo insights';
    case 'demographic_gap': return 'Comparing the age and gender mix of both audiences with Qloo demographics';
    case 'brand_positioning': return 'Comparing how Qloo tags ' + brand + ' and ' + rival + ' with Qloo compare';
    case 'follow_lead': {
      const seed = gapItem(ctx, input.entity_ref);
      let words;
      try { words = leadDomains(leadLocality(ctx, input)).map(d => LEAD_WORDS[d]); } catch (_) { words = LEAD_DOMAINS.map(d => LEAD_WORDS[d]); }
      return 'Following the lead: what ' + (seed ? seed.name + ' fans' : 'these fans') + ' also love in ' + listWords(words) + ', with Qloo insights';
    }
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
  TOOL_DEFS, DISCOVERY_DEFS, DOMAINS, ENDPOINTS, createContext, executeTool, describeCall, endpointsUsed, entityName, brandId, localityId,
};
