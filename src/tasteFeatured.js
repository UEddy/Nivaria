// Taste Gap: the featured briefs. Ten popular rival pairs, shown as one-click
// chips on the Taste Gap page and served from the database with no Qloo or
// model calls, so a visitor (or a judge) always has a finished brief to open.
//
// Writing them is quota-heavy, so it happens two ways:
//   - scripts/generate-featured.js asks the running server (POST
//     /internal/taste/featured/:key, src/routes/tasteInternal.js) to write each
//     brief with Gemini only (featuredChain), one at a time. A brief written
//     that way is marked FEATURED_VERSION and replaces any older brief for the
//     pair; a pair that already has a good one is skipped, so the script
//     resumes where it stopped.
//   - At boot, a pair marked boot (the original two examples) with no brief at
//     all is written with the configured chain, so a fresh database is never
//     empty. Those are not marked current, so the script replaces them.
//
// TASTE_EXAMPLES controls the boot step: unset fills missing boot pairs,
// refresh rewrites boot pairs that have no current featured brief (it never
// touches the script's Gemini briefs), off skips it. A boot pair that fails is
// tried again RETRY_DELAY_MS later, up to MAX_ATTEMPTS, then at the next boot.
// Nothing generated here is ever committed: the database is git-ignored and
// Qloo response data must stay out of the repo.

const runs = require('./tasteRuns');
const llm = require('./taste/llm');

// Bump to have the script rewrite every featured brief.
const FEATURED_VERSION = 1;

const RETRY_DELAY_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// Brand names as Qloo spells them, so a brand picked from the form's
// autocomplete matches the featured brief in the cache.
const FEATURED = [
  { key: 'starbucks-dunkin-nyc', brand: 'Starbucks', rivals: ["Dunkin' Donuts"], city: 'New York', boot: true },
  { key: 'glossier-fenty', brand: 'Glossier', rivals: ['Fenty Beauty'], city: null, boot: true },
  { key: 'nike-adidas-la', brand: 'Nike', rivals: ['Adidas'], city: 'Los Angeles' },
  { key: 'coca-cola-pepsi-atlanta', brand: 'Coca-Cola', rivals: ['Pepsi'], city: 'Atlanta' },
  { key: 'mcdonalds-burger-king-miami', brand: "McDonald's", rivals: ['Burger King'], city: 'Miami' },
  { key: 'netflix-disney-plus', brand: 'Netflix', rivals: ['Disney+'], city: null },
  { key: 'spotify-apple-music', brand: 'Spotify', rivals: ['Apple Music'], city: null },
  { key: 'chipotle-taco-bell-austin', brand: 'Chipotle', rivals: ['Taco Bell'], city: 'Austin' },
  { key: 'sephora-ulta-chicago', brand: 'Sephora', rivals: ['Ulta'], city: 'Chicago' },
  { key: 'lululemon-athleta-sf', brand: 'Lululemon', rivals: ['Athleta'], city: 'San Francisco' },
];

let generating = false;

const pairOf = key => FEATURED.find(p => p.key === key) || null;
const inputOf = p => ({ brand: p.brand, rivals: p.rivals, city: p.city });
const labelOf = p => p.brand + ' vs ' + p.rivals.join(' and ') + (p.city ? ' in ' + p.city : '');

// Gemini only, both models (each has its own daily quota). FEATURED_CHAIN
// overrides it; the tests use the scripted stand-in.
function featuredChain() {
  return process.env.FEATURED_CHAIN || 'gemini,gemini:' + (process.env.GEMINI_SECOND_MODEL || llm.SECOND_GEMINI_MODEL);
}

function realModelConfigured() {
  try {
    return llm.buildChain().some(e => e.name !== 'scripted');
  } catch (_) {
    return false;
  }
}

// The brief the script wrote for this pair, if it is still good.
function currentRow(key, rows = runs.featuredRows()) {
  return rows.find(r => r.example_key === key && r.example_version === FEATURED_VERSION && r.good) || null;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

// only: retry just these keys (the ones that failed last time).
async function ensureFeatured({ mode = process.env.TASTE_EXAMPLES, only = null, attempt = 1 } = {}) {
  if (mode === 'off' || generating) return;
  const problem = runs.configProblem();
  if (problem) { console.log('[taste] featured briefs not generated: ' + problem); return; }
  if (!realModelConfigured()) { console.log('[taste] featured briefs not generated: only the scripted stand-in is configured'); return; }

  const rows = runs.featuredRows();
  const have = new Set(rows.map(r => r.example_key));
  const todo = FEATURED.filter(p => p.boot && (only ? only.includes(p.key)
    : mode === 'refresh' ? !currentRow(p.key, rows) : !have.has(p.key)));
  if (!todo.length) return;

  const failed = [];
  generating = true;
  try {
    for (const p of todo) {
      console.log('[taste] generating featured brief ' + p.key);
      const { id } = await runs.runExample(p.key, inputOf(p));
      if (id) console.log('[taste] featured brief ' + p.key + ' ready (run ' + id + ')');
      else failed.push(p.key);
    }
  } finally {
    generating = false;
  }

  if (!failed.length) return;
  if (attempt >= MAX_ATTEMPTS) {
    console.log('[taste] featured briefs failed: ' + failed.join(', ') + '; they will be retried at the next boot');
    return;
  }
  console.log('[taste] featured briefs failed: ' + failed.join(', ') + '; retrying in ' + RETRY_DELAY_MS / 60000 + ' minutes');
  setTimeout(() => {
    ensureFeatured({ mode, only: failed, attempt: attempt + 1 })
      .catch(err => console.warn('[taste] featured briefs failed: ' + err.message));
  }, RETRY_DELAY_MS).unref?.();
}

// ── The featured script ───────────────────────────────────────────────────────

// Each pair's state for the script: current (a good brief from the script),
// stale (a brief, but not one the script wrote) or missing.
function featuredStatus() {
  const rows = runs.featuredRows();
  return FEATURED.map(p => {
    const cur = currentRow(p.key, rows);
    const any = rows.find(r => r.example_key === p.key);
    return {
      key: p.key,
      label: labelOf(p),
      status: cur ? 'current' : any ? 'stale' : 'missing',
      run_id: (cur || any)?.id || null,
      model: (cur || any)?.model || null,
      finished_at: (cur || any)?.finished_at || null,
    };
  });
}

// Write one pair's brief with Gemini only. Returns { key, result, ... } where
// result is skipped (a good current brief exists and force is off), done,
// quota (every Gemini model answered 429, so the script should stop), busy
// (another brief is being written), failed or unknown.
async function generateFeatured(key, { force = false } = {}) {
  const pair = pairOf(key);
  if (!pair) return { key, result: 'unknown', error: 'No featured pair has that key.' };
  const label = labelOf(pair);
  if (!force) {
    const cur = currentRow(pair.key);
    if (cur) return { key, label, result: 'skipped', run_id: cur.id, headline: cur.headline, model: cur.model };
  }
  if (!String(process.env.QLOO_API_KEY || '').trim()) return { key, label, result: 'failed', error: 'QLOO_API_KEY is not set on this server.' };
  try {
    llm.buildChain(featuredChain());
  } catch (err) {
    return { key, label, result: 'failed', error: err.message };
  }
  if (generating) return { key, label, result: 'busy', error: 'Another featured brief is being written. Try again in a few minutes.' };

  generating = true;
  const started = Date.now();
  try {
    const { id, error } = await runs.runExample(pair.key, inputOf(pair), { chain: featuredChain(), version: FEATURED_VERSION });
    const ms = Date.now() - started;
    if (id) {
      const row = runs.featuredRows().find(r => r.id === id);
      return { key, label, result: 'done', run_id: id, headline: row?.headline || '', model: row?.model || null, ms };
    }
    const quota = Boolean(error?.chainExhausted) && error?.status === 429;
    return { key, label, result: quota ? 'quota' : 'failed', error: String(error?.message || 'The run failed').slice(0, 300), ms };
  } finally {
    generating = false;
  }
}

// ── The Taste Gap page ────────────────────────────────────────────────────────

// Every pair in order, with its finished brief (the parts a chip and the
// featured card need) or null when it has none yet.
function listFeatured() {
  const rows = runs.featuredRows();
  return FEATURED.map((p, i) => {
    const row = rows.find(r => r.example_key === p.key && r.good) || null;
    return {
      key: p.key,
      featured: i === 0,
      brand: row?.brand || p.brand,
      rivals: row?.rivals || p.rivals,
      city: p.city,
      run: row && {
        id: row.id,
        finished_at: row.finished_at,
        model: row.model,
        headline: row.headline,
        summary: row.summary,
        win_first: row.win_first,
        segments: row.segments,
        hotspots: row.hotspots,
      },
    };
  });
}

module.exports = {
  FEATURED, FEATURED_VERSION, featuredChain,
  ensureFeatured, featuredStatus, generateFeatured, listFeatured,
};
