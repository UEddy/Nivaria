// Taste Gap: seeded example runs, so a visitor (or a judge) sees a finished
// brief on the Taste Gap page before running anything.
//
// The examples are generated for real, with the configured Qloo key and model
// chain, the first time the server boots with both configured, and are then
// served from the database. Nothing generated here is ever committed: the
// database is git-ignored and Qloo response data must stay out of the repo.
//
// TASTE_EXAMPLES controls it:
//   unset    generate any example that is missing, at boot
//   refresh  regenerate every example at boot (the old one stays until the
//            new one succeeds)
//   off      never generate
//
// Generation is skipped when the only configured model is the scripted
// stand-in, so templated prose never gets cached as an example. The examples
// run one after the other in the background after the server starts listening.

const runs = require('./tasteRuns');
const llm = require('./taste/llm');

const EXAMPLES = [
  { key: 'starbucks-dunkin-nyc', featured: true, brand: 'Starbucks', rivals: ["Dunkin'"], city: 'New York' },
  { key: 'glossier-fenty', featured: false, brand: 'Glossier', rivals: ['Fenty Beauty'], city: null },
];

let generating = false;

function realModelConfigured() {
  try {
    return llm.buildChain().some(e => e.name !== 'scripted');
  } catch (_) {
    return false;
  }
}

async function ensureExamples({ mode = process.env.TASTE_EXAMPLES } = {}) {
  if (mode === 'off' || generating) return;
  const problem = runs.configProblem();
  if (problem) { console.log('[taste] examples not generated: ' + problem); return; }
  if (!realModelConfigured()) { console.log('[taste] examples not generated: only the scripted stand-in is configured'); return; }

  const have = new Set(runs.exampleKeys());
  const todo = EXAMPLES.filter(ex => mode === 'refresh' || !have.has(ex.key));
  if (!todo.length) return;

  generating = true;
  try {
    for (const ex of todo) {
      console.log('[taste] generating example ' + ex.key);
      const id = await runs.runExample(ex.key, { brand: ex.brand, rivals: ex.rivals, city: ex.city });
      console.log(id ? '[taste] example ' + ex.key + ' ready (run ' + id + ')' : '[taste] example ' + ex.key + ' failed; it will be retried at the next boot');
    }
  } finally {
    generating = false;
  }
}

// Finished examples for the Taste Gap page, featured first, in EXAMPLES order.
function listExamples() {
  const order = new Map(EXAMPLES.map((ex, i) => [ex.key, i]));
  return runs.listExamples()
    .filter(r => order.has(r.example_key))
    .map(r => ({ ...r, featured: EXAMPLES[order.get(r.example_key)].featured }))
    .sort((a, b) => (b.featured - a.featured) || (order.get(a.example_key) - order.get(b.example_key)));
}

module.exports = { EXAMPLES, ensureExamples, listExamples };
