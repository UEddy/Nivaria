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
    refs: new Map(),         // ref -> { kind, id, rival_id?, geohash? }
    refKeys: new Map(),      // kind + ':' + key -> ref, so one thing keeps one ref
    refCounts: {},
  };
}

const REF_PREFIX = { brand: 'b', locality: 'l', entity: 'e', cell: 'c' };

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
  const d = await qloo.search(query.trim(), { types: 'urn:entity:brand', take: 5 });
  const results = (d?.results || []).map(e => {
    const p = e.properties || {};
    ctx.entities.set(e.entity_id, { name: e.name, image: p.image?.url || null, type: 'brand' });
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

async function findCity(ctx, { query }) {
  if (!query || typeof query !== 'string') throw toolError('query is required.');
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
  const rivalTop = await qloo.insights(cfg.type, {
    'signal.interests.entities': rival, take: GAP_TAKE + (boundary ? PLACE_SPARES : 2), ...loc,
  });
  const exclude = new Set([brand, rival]);
  const inCity = e => !boundary || e.location?.lat == null || e.location?.lon == null
    || insideBoundary(boundary, e.location.lat, e.location.lon);
  const top = entitiesOf(rivalTop).filter(e => !exclude.has(e.entity_id) && inCity(e)).slice(0, GAP_TAKE);
  if (!top.length) {
    return { result: { domain, rows: [], note: 'Qloo returned no ' + cfg.label + ' for this rival.' }, summary: 'No results' };
  }

  const ids = top.map(e => e.entity_id);
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
      ? 'Biggest gap: ' + lead.name + ' (' + pts(lead.rival_affinity) + ' vs ' + pts(lead.our_affinity) + '), mean gap ' + pts(mean) + ' points'
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

async function labelCell(cell, signalId) {
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

const cellLabel = c => c.label || c.geohash;

async function geoGap(ctx, input) {
  const [brand, rival] = requirePair(ctx, input);
  const locality = requireLocality(ctx, input.locality_id);

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
    ...hotspots.slice(0, GEO_LABELED).map(c => labelCell(c, rival)),
    ...ourStrongest.map(c => labelCell(c, brand)),
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
    summary: 'Rival leads in ' + pts(stats.share_rival_leads) + '% of ' + cells.length
      + ' cells; widest gap in ' + cellLabel(top) + ' (' + pts(top.rival_affinity) + ' vs ' + pts(top.our_affinity) + ')',
  };
}

// ── demographic_gap ───────────────────────────────────────────────────────────

async function demographicGap(ctx, input) {
  const [brand, rival] = requirePair(ctx, input);
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

// ── Definitions ───────────────────────────────────────────────────────────────

const BRAND_PAIR = {
  brand_id: { type: 'string', description: "Our brand's ref from search_brands, like b1." },
  rival_id: { type: 'string', description: "The rival's ref from search_brands, like b2." },
};

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
  TOOL_DEFS, DOMAINS, createContext, executeTool, describeCall, entityName, brandId, localityId,
};
