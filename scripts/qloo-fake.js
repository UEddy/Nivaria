// A fake Qloo for offline Taste Gap work: tests, and demos with no Qloo key.
//
//   node -r ./scripts/qloo-fake.js src/server.js        (with LLM_CHAIN=scripted)
//
// Requiring this file swaps search, insights and compare on src/qloo/client.js
// for synthetic answers in the response shapes documented there, and sets a
// placeholder QLOO_API_KEY so the server's config check passes. Every number
// comes from a hash of the request, so the same run gives the same brief. None
// of it is Qloo data (committing real Qloo responses is against the hackathon
// rules), and the names are invented.

const client = require('../src/qloo/client');

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const title = s => String(s).replace(/\b\w/g, c => c.toUpperCase());

const NAMES = {
  'urn:entity:artist': ['Neon Harbor', 'The Velvet Static', 'Mira Sol', 'Low Tide Club', 'Kasey Vale', 'Paper Comets', 'Juno Reyes', 'Glass Orchard', 'Static Bloom', 'Ode Collective', 'Rae Lune', 'North Arcade', 'Sable Fox', 'Dusk Runner', 'Halcyon Days', 'Echo Park Kids', 'Tidal Hearts'],
  'urn:entity:movie': ['The Long Weekend', 'Glass City', 'Midnight Ferry', 'Second Act', 'Paper Moons', 'Coastline', 'The Understudy', 'Late Bloom', 'Night Shift', 'Signal Fire', 'Open Water', 'The Night Market', 'Undertow', 'Small Hours', 'Northbound', 'Afterglow', 'The Archive'],
  'urn:entity:tv_show': ['Runway Rivals', 'House of Threads', 'The Pantry', 'Street Style Live', 'Love on Location', 'Office Hours', 'Brunch Club', 'The Fixer Uppers', 'Studio Nights', 'Tiny Kitchens', 'City Lights', 'Glow Up Camp', 'Market Day', 'The Collective', 'Weekend Getaway', 'Night Owls', 'Main Street'],
  'urn:entity:brand': ['Lumen Goods', 'Northwind Apparel', 'Copper Kettle', 'Fable Skin', 'Trailhead Co', 'Ember Studio', 'Mosaic Market', 'Atlas Supply', 'Sunday Social', 'Harbor Mill', 'Pioneer Pantry', 'Vela Beauty', 'Kinfolk Coffee', 'Rove Outfitters', 'Bloom Bar', 'Common Thread', 'Field Day'],
  'urn:entity:place': ['The Corner Room', 'Blue Door Cafe', 'Night Owl Records', 'Pier 9 Market', 'The Gallery Bar', 'Sunset Roasters', 'Old Mill Books', 'Canal Street Deli', 'The Loft', 'Harbor House', 'Little Fern', 'The Arcade', 'Union Hall', 'Ferry Tavern', 'The Garden Room', 'Ridge Bakery', 'Lantern Bar'],
};
const TAGS = {
  'urn:entity:artist': ['Indie Pop', 'R&B', 'Hip Hop', 'Electronic'],
  'urn:entity:movie': ['Drama', 'Comedy', 'Romance', 'Thriller'],
  'urn:entity:tv_show': ['Reality', 'Fashion', 'Cooking', 'Comedy'],
  'urn:entity:brand': ['Lifestyle', 'Beauty', 'Apparel', 'Food'],
  'urn:entity:place': ['Cafe', 'Bar', 'Record Store', 'Bakery'],
};
const AREAS = [
  ['Williamsburg', 'Brooklyn'], ['Astoria', 'Queens'], ['Harlem', 'New York County'], ['Bushwick', 'Brooklyn'],
  ['Park Slope', 'Brooklyn'], [null, 'Staten Island'], ['Long Island City', 'Queens'], ['Chelsea', 'New York County'],
  [null, 'Bronx'], ['Greenpoint', 'Brooklyn'], ['Flushing', 'Queens'], ['SoHo', 'New York County'],
];

const tagsFor = (type, i) => [{ type: 'urn:tag:genre:qloo', name: TAGS[type][i % 4] }, { type: 'urn:tag:genre:qloo', name: TAGS[type][(i + 1) % 4] }];

// Brand tags in Qloo's shapes, for rival discovery: a top-level genre (too
// broad to count), a specific genre on even brands (shared with every brand
// search returns), and the generic tags that must never mark a retailer:
// industry Retail, B2C, and a distribution channel saying where it is sold.
const tag = (type, name) => ({ type, name, id: type + ':' + slug(name).replace(/-/g, '_') });
const COFFEE = { type: 'urn:tag:genre:brand', name: 'Coffee & Tea', id: 'urn:tag:genre:brand:food_and_beverage:drinks:coffee_and_tea' };
const brandTags = i => [
  tag('urn:tag:genre:brand', TAGS['urn:entity:brand'][i % 4]),
  ...(i % 2 === 0 ? [COFFEE] : []),
  tag('urn:tag:industry:qloo', 'Retail'),
  tag('urn:tag:business_model:qloo', 'B2C'),
  tag('urn:tag:distribution_channel:qloo', 'Supermarkets'),
];

function entity(type, i, signal, scale) {
  const id = slug(type.split(':').pop()) + '-' + i;
  return {
    entity_id: id,
    name: NAMES[type][i],
    popularity: 0.5 + hash(id) / 2,
    query: { affinity: Math.round(Math.min(0.99, scale(i, hash(signal + id))) * 1000) / 1000 },
    properties: type === 'urn:entity:place' ? { geocode: { name: AREAS[i % AREAS.length][0], admin2_region: AREAS[i % AREAS.length][1] } } : {},
    tags: type === 'urn:entity:brand' ? brandTags(i) : tagsFor(type, i),
  };
}

// Brands starting with S get an inline image and brands starting with G a
// broken image URL, so the UI's image and placeholder paths both get used.
function fakeImage(query) {
  const c = String(query).trim()[0]?.toLowerCase();
  if (c === 's') return { image: { url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#1e7a4f"/></svg>') } };
  if (c === 'g') return { image: { url: 'https://images.invalid/missing.png' } };
  return {};
}

async function search(query, { types } = {}) {
  // Like the real search for "New York": a state with the same name ranks
  // above the city, so find_city has to pick the city from properties.place.
  if (types === 'urn:entity:locality') {
    // A city Qloo does not know, for the agent's revised plan.
    if (/^atlantis$/i.test(String(query).trim())) return { results: [] };
    return {
      results: [
        { entity_id: 'locality-state-' + slug(query), name: title(query), disambiguation: title(query) + ', Fakeland', properties: { place: 'state', admin_level: 4 } },
        { entity_id: 'locality-' + slug(query), name: title(query), disambiguation: title(query) + ', ' + title(query) + ', Fakeland', properties: { place: 'city', admin_level: 5, population: 1000000 } },
      ],
    };
  }
  return {
    results: [{
      entity_id: 'brand-' + slug(query),
      name: title(query),
      popularity: 0.8 + hash(query) / 5,
      properties: { short_description: 'A consumer brand (synthetic test data).', ...fakeImage(query) },
      // Coffee & Tea is shared with the even brands insights returns, and is
      // the category the filtered discovery pass uses; the rest are too
      // generic to count.
      tags: [tag('urn:tag:genre:brand', 'Food & Beverage'), { ...COFFEE, tag_id: COFFEE.id, id: undefined },
        tag('urn:tag:industry:qloo', 'Retail'), tag('urn:tag:business_model:qloo', 'B2C')],
    }],
  };
}

async function insights(type, params = {}) {
  const signal = params['signal.interests.entities'];
  if (type === 'urn:demographics') {
    const q = k => Math.round((hash(signal + k) * 1.4 - 0.7) * 1000) / 1000;
    const age = {};
    for (const b of ['24_and_younger', '25_to_29', '30_to_34', '35_to_44', '45_to_54', '55_and_older']) age[b] = q(b);
    return { results: { demographics: [{ entity_id: signal, query: { age, gender: { female: q('f'), male: q('m') } } }] } };
  }
  if (type === 'urn:heatmap') {
    const heatmap = [];
    for (let i = 0; i < 64; i += 1) {
      const lat = 40.58 + Math.floor(i / 8) * 0.035;
      const lng = -74.12 + (i % 8) * 0.045;
      heatmap.push({
        location: { latitude: lat, longitude: lng, geohash: 'dr5' + i.toString(36).padStart(3, '0') },
        query: { affinity: Math.round(hash(signal + i) * 1000) / 1000, popularity: 0.3 + hash('pop' + i) * 0.7 },
      });
    }
    return { results: { heatmap } };
  }
  if (params['filter.location.geohash']) {
    const i = parseInt(params['filter.location.geohash'].slice(3), 36) % AREAS.length;
    return { results: { entities: [0, 1, 2].map(k => entity('urn:entity:place', (i + k) % 17, signal, () => 0.5)).map(e => ({ ...e, properties: { geocode: { name: AREAS[i][0], admin2_region: AREAS[i][1], admin1_region: 'New York' } } })) } };
  }
  const names = NAMES[type];
  if (!names) return { results: { entities: [] } };
  const filter = params['filter.results.entities'];
  if (filter) {
    const ids = String(filter).split(',');
    // Our audience: lower affinity than the rival on most of the rival's top list.
    return { results: { entities: ids.map(id => entity(type, Number(id.split('-').pop()), signal, (i, h) => 0.2 + h * 0.6)) } };
  }
  // The discovery pass filtered to a category tag: one brand from the overlap
  // list, and one same-category brand the overlap list does not have.
  if (type === 'urn:entity:brand' && params['filter.tags']) {
    return {
      results: {
        entities: [
          entity(type, 0, signal, () => 0.95),
          { entity_id: 'brand-roaster', name: 'Lantern Roasters', popularity: 0.7, query: { affinity: 0.8 }, properties: {}, tags: [COFFEE, tag('urn:tag:industry:qloo', 'Retail')] },
        ],
      },
    };
  }
  const take = Math.min(Number(params.take) || 10, names.length);
  const list = Array.from({ length: take }, (_, i) => entity(type, i, signal, (k, h) => 0.97 - k * 0.02 - h * 0.05));
  // Rival discovery asks for 20 brands (audience_gap asks for fewer). Its list
  // also holds what a competitor is not: a sub-brand of the same family at the
  // top, and a supermarket chain, so the discovery flags get used.
  if (type === 'urn:entity:brand' && Number(params.take) >= 20 && /^brand-/.test(signal)) {
    const own = title(String(signal).slice(6).replace(/-/g, ' '));
    list.unshift({ entity_id: 'brand-family', name: own + ' Reserve', popularity: 0.6, query: { affinity: 0.99 }, properties: {}, tags: [COFFEE] });
    list[2] = { ...list[2], tags: [...list[2].tags, COFFEE, tag('urn:tag:industry:qloo', 'Supermarket Chain'), tag('urn:tag:brand_type:qloo', 'Retail Brand')] };
  }
  return { results: { entities: list } };
}

async function compare(a, b) {
  const tag = (name, score) => ({ name, subtype: 'urn:tag:keyword', query: { score } });
  return {
    results: {
      tags: [tag('Lifestyle', 0.9), tag('Streetwear', 0.8), tag('Gen Z', 0.7), tag('Lifestyle', 0.6)],
      a: [{ name: 'Minimalist' }, { name: 'Heritage' }],
      b: [{ name: 'Bold Colors' }, { name: 'Celebrity Founder' }, { name: 'Inclusive Sizing' }],
    },
  };
}

client.search = search;
client.insights = insights;
client.compare = compare;
if (!process.env.QLOO_API_KEY) process.env.QLOO_API_KEY = 'fake';

module.exports = { search, insights, compare };
