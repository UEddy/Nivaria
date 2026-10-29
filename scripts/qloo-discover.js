// Check rival discovery against the real Qloo API, with no model calls.
//
//   node scripts/qloo-discover.js Starbucks Glossier
//
// For each brand: search_brands, then discover_rivals, through the same tool
// code the agent uses (src/qloo/tools.js), and prints every candidate with its
// audience affinity, the Qloo tags it shares with the brand, and the flags
// that mark what is not a competitor. Uses QLOO_API_KEY from .env and spends
// two Qloo calls per brand, and nothing from the model chain.

require('dotenv').config();
const tools = require('../src/qloo/tools');

async function check(name) {
  const ctx = tools.createContext();
  const found = await tools.executeTool(ctx, 'search_brands', { query: name });
  if (!found.ok) throw new Error(found.error);
  const brand = found.result.results[0];
  if (!brand) { console.log('\n' + name + ': Qloo found no brand'); return; }
  const disc = await tools.executeTool(ctx, 'discover_rivals', { brand_id: brand.ref });
  if (!disc.ok) throw new Error(disc.error);
  console.log('\n' + brand.name + ' (' + brand.ref + '): ' + disc.summary);
  console.log('  affinity  name                           shared tags / flags');
  for (const c of ctx.discovery.candidates) {
    const notes = [c.shared_tags.slice(0, 4).join(', ') || 'no shared tags', c.flags.length ? 'FLAG: ' + c.flags.join(', ') : ''].filter(Boolean).join('  ');
    console.log('  ' + String(c.affinity).padStart(8) + '  ' + c.name.padEnd(30).slice(0, 30) + ' ' + notes);
  }
}

(async () => {
  const names = process.argv.slice(2);
  if (!names.length) { console.error('Usage: node scripts/qloo-discover.js <brand> [<brand> ...]'); process.exit(1); }
  for (const n of names) await check(n);
})().catch(err => { console.error(err.message); process.exit(1); });
