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
// A fresh deploy (an empty database volume) has none, so the first boot
// generates them all; one that fails (a provider 503, a spent quota) is tried
// again RETRY_DELAY_MS later, up to MAX_ATTEMPTS, and after that at the next boot.

const runs = require('./tasteRuns');
const llm = require('./taste/llm');

const RETRY_DELAY_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

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

// only: retry just these keys (the ones that failed last time).
async function ensureExamples({ mode = process.env.TASTE_EXAMPLES, only = null, attempt = 1 } = {}) {
  if (mode === 'off' || generating) return;
  const problem = runs.configProblem();
  if (problem) { console.log('[taste] examples not generated: ' + problem); return; }
  if (!realModelConfigured()) { console.log('[taste] examples not generated: only the scripted stand-in is configured'); return; }

  const have = new Set(runs.exampleKeys());
  const todo = EXAMPLES.filter(ex => (only ? only.includes(ex.key) : mode === 'refresh' || !have.has(ex.key)));
  if (!todo.length) return;

  const failed = [];
  generating = true;
  try {
    for (const ex of todo) {
      console.log('[taste] generating example ' + ex.key);
      const id = await runs.runExample(ex.key, { brand: ex.brand, rivals: ex.rivals, city: ex.city });
      if (id) console.log('[taste] example ' + ex.key + ' ready (run ' + id + ')');
      else failed.push(ex.key);
    }
  } finally {
    generating = false;
  }

  if (!failed.length) return;
  if (attempt >= MAX_ATTEMPTS) {
    console.log('[taste] examples failed: ' + failed.join(', ') + '; they will be retried at the next boot');
    return;
  }
  console.log('[taste] examples failed: ' + failed.join(', ') + '; retrying in ' + RETRY_DELAY_MS / 60000 + ' minutes');
  setTimeout(() => {
    ensureExamples({ mode, only: failed, attempt: attempt + 1 })
      .catch(err => console.warn('[taste] examples failed: ' + err.message));
  }, RETRY_DELAY_MS).unref?.();
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
