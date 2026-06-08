// ─────────────────────────────────────────────────────────────────────────────
// One-time production cleanup: remove the Phase 9 demo data leak.
//
// BACKGROUND
//   seedPhase9DemoData() (src/db.js) was, for a time, invoked WITHOUT the
//   `NODE_ENV !== 'production'` guard that protects seedDemoData(). Because that
//   function hardcodes competitor_id 1/2/3 for the backdated "changes" rows it
//   inserts (and seeds 18 fictional deals for user #1), running it in production
//   stapled "Acme Corp"/"NovaTech" demo briefs and fake deals onto whatever REAL
//   competitor happened to occupy ids 1/2/3 — e.g. a freshly added Stripe.
//
//   The seed is now gated (src/db.js), so no NEW production DB will be polluted.
//   This migration removes the rows already written to the live database.
//
// SAFETY MODEL (this is the important part)
//   In production the demo competitor ROWS were never created (seedDemoData is
//   dev-only), so competitor_id 1/2/3 are REAL competitors the user added. We
//   therefore must NOT delete by competitor_id. Instead every demo row is matched
//   by a highly specific, multi-field signature taken verbatim from the seed:
//     • changes  — exact seed headline AND a confirming marker substring inside
//                  the analysis JSON. A headline match without the marker is
//                  treated as ambiguous and SKIPPED with a warning.
//     • deals    — exact (deal_name, outcome, deal_value_usd) triple.
//     • competitors — exact (name, url) pair (a no-op in production; defensive).
//   Anything that doesn't match every field of a signature is left untouched.
//
//   Idempotent by nature: after the first run the signatures match nothing, so
//   subsequent boots delete zero rows. This is the same "safe on every boot"
//   convention used by runPhase10WorkspaceMigration(). That is its self-disable.
//
//   Production-only: returns immediately when NODE_ENV !== 'production' so local
//   dev databases keep their demo data. Tests may force-run via opts.force.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Exact "changes" signatures inserted by seedPhase9DemoData(). headline is the
// primary key; marker is a substring that MUST appear in the change's analysis
// JSON to confirm it is the seed row and not a coincidental real scrape.
const DEMO_CHANGE_SIGNATURES = [
  { headline: 'Acme Corp restructured pricing with an aggressive Pro discount', marker: 'Acme reduced Pro pricing' },
  { headline: 'Acme Corp removed Pro seat caps',                                marker: 'Acme dropped the per-seat ceiling on Pro' },
  { headline: 'NovaTech launched an AI writing assistant',                      marker: 'NovaTech entered our core feature territory' },
];

// Exact (deal_name, outcome, deal_value_usd) triples inserted by the seed. A
// null value matches only a NULL deal_value_usd.
const DEMO_DEALS = [
  { name: 'Northwind Traders',   outcome: 'lost',    value: 42000 },
  { name: 'Globex Logistics',    outcome: 'lost',    value: 38000 },
  { name: 'Initech Platform',    outcome: 'lost',    value: 55000 },
  { name: 'Soylent Foods',       outcome: 'lost',    value: 27000 },
  { name: 'Umbrella Health',     outcome: 'lost',    value: 61000 },
  { name: 'Vandelay Imports',    outcome: 'lost',    value: null  },
  { name: 'Stark Solutions',     outcome: 'lost',    value: 48000 },
  { name: 'Wayne Manufacturing', outcome: 'lost',    value: 33000 },
  { name: 'Hooli Cloud',         outcome: 'lost',    value: 72000 },
  { name: 'Pied Piper Data',     outcome: 'lost',    value: 29000 },
  { name: 'Cyberdyne Systems',   outcome: 'stalled', value: 36000 },
  { name: 'Tyrell Corp',         outcome: 'stalled', value: 45000 },
  { name: 'Oscorp Labs',         outcome: 'lost',    value: 31000 },
  { name: 'Contoso Corp',        outcome: 'won',     value: 25000 },
  { name: 'Fabrikam Inc',        outcome: 'won',     value: 40000 },
  { name: 'Adventure Works',     outcome: 'won',     value: 52000 },
  { name: 'Litware Group',       outcome: 'won',     value: 18000 },
  { name: 'Proseware',           outcome: 'won',     value: 33000 },
];

// Exact (name, url) pairs created only by seedDemoData() (dev-only). Present here
// defensively — in production these rows do not exist, so this matches nothing.
const DEMO_COMPETITORS = [
  { name: 'Acme Corp',  url: 'https://acmecorp.com/pricing' },
  { name: 'NovaTech',   url: 'https://novatech.io/features' },
  { name: 'Horizon AI', url: 'https://horizonai.com' },
];

/**
 * Remove Phase 9 demo data from the live database.
 *
 * @param {object} db   The DatabaseWrapper from src/db.js (prepare/savepoint).
 * @param {object} [opts]
 * @param {boolean} [opts.force]   Run regardless of NODE_ENV (tests only).
 * @param {object}  [opts.log]     Logger ({log, warn}); defaults to console.
 * @returns {{changes:number, deals:number, competitors:number, skipped:number}}
 */
function removePhase9DemoData(db, opts = {}) {
  const log = opts.log || console;
  const result = { changes: 0, deals: 0, competitors: 0, skipped: 0 };

  if (!opts.force && process.env.NODE_ENV !== 'production') {
    return result; // dev/test DBs keep their demo data
  }

  // ── 1. Identify demo CHANGES by exact headline + confirming analysis marker ──
  const changeIds = [];
  for (const sig of DEMO_CHANGE_SIGNATURES) {
    const rows = db.prepare(
      'SELECT id, competitor_id, analysis FROM changes WHERE headline = ?'
    ).all(sig.headline);
    for (const row of rows) {
      const analysis = typeof row.analysis === 'string' ? row.analysis : '';
      if (analysis.includes(sig.marker)) {
        changeIds.push(row.id);
        log.log(`[CLEANUP] Phase 9 demo brief identified: change #${row.id} ` +
          `(competitor_id=${row.competitor_id}) "${sig.headline}"`);
      } else {
        result.skipped++;
        log.warn(`[CLEANUP] SKIP: change #${row.id} headline matches a demo ` +
          `signature but analysis marker "${sig.marker}" is absent — treating ` +
          `as real data, not deleting.`);
      }
    }
  }

  // ── 2. Identify demo DEALS by exact (name, outcome, value) triple ──
  const dealIds = [];
  for (const d of DEMO_DEALS) {
    const rows = d.value === null
      ? db.prepare('SELECT id, user_id, competitor_id FROM deals WHERE deal_name = ? AND outcome = ? AND deal_value_usd IS NULL').all(d.name, d.outcome)
      : db.prepare('SELECT id, user_id, competitor_id FROM deals WHERE deal_name = ? AND outcome = ? AND deal_value_usd = ?').all(d.name, d.outcome, d.value);
    for (const row of rows) {
      dealIds.push(row.id);
      log.log(`[CLEANUP] Phase 9 demo deal identified: deal #${row.id} ` +
        `"${d.name}" (${d.outcome}, $${d.value === null ? 'null' : d.value}, ` +
        `user_id=${row.user_id})`);
    }
  }

  // ── 3. Identify demo COMPETITORS by exact (name, url) — defensive, prod no-op ──
  const competitorIds = [];
  for (const c of DEMO_COMPETITORS) {
    const rows = db.prepare('SELECT id FROM competitors WHERE name = ? AND url = ?').all(c.name, c.url);
    for (const row of rows) {
      competitorIds.push(row.id);
      log.log(`[CLEANUP] Phase 9 demo competitor identified: competitor #${row.id} "${c.name}"`);
    }
  }

  if (changeIds.length === 0 && dealIds.length === 0 && competitorIds.length === 0) {
    // Nothing matched — either already cleaned or never present. Self-disabled.
    log.log('[CLEANUP] No Phase 9 demo data found — nothing to remove.' +
      (result.skipped ? ` (${result.skipped} ambiguous row(s) skipped.)` : ''));
    return result;
  }

  // ── 4. Delete everything atomically (one savepoint, persisted once) ──
  db.savepoint(() => {
    for (const id of changeIds) {
      db.prepare('DELETE FROM changes WHERE id = ?').run(id);
      result.changes++;
    }
    for (const id of dealIds) {
      db.prepare('DELETE FROM deals WHERE id = ?').run(id);
      result.deals++;
    }
    // If a demo competitor row somehow exists, also remove its remaining changes
    // so we don't orphan them (its demo deals are already handled above).
    for (const id of competitorIds) {
      db.prepare('DELETE FROM changes WHERE competitor_id = ?').run(id);
      db.prepare('DELETE FROM competitors WHERE id = ?').run(id);
      result.competitors++;
    }
  });

  log.log(`[CLEANUP] Phase 9 demo data removed: ${result.changes} change(s)/brief(s), ` +
    `${result.deals} deal(s), ${result.competitors} competitor(s).` +
    (result.skipped ? ` ${result.skipped} ambiguous row(s) skipped.` : ''));

  return result;
}

module.exports = { removePhase9DemoData, DEMO_CHANGE_SIGNATURES, DEMO_DEALS, DEMO_COMPETITORS };
