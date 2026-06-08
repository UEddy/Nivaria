// Verification for the Phase 9 demo-data leak fix.
//
//   Test 1 — Production gate: seedPhase9DemoData() does NOT seed when
//            NODE_ENV=production (a fresh prod DB boots with 0 changes/0 deals).
//   Test 2 — Cleanup removes ONLY demo data (exact-signature matched).
//   Test 3 — Real competitors / real changes / real deals are NOT touched, and
//            ambiguous look-alikes (matching headline w/o marker, matching name
//            w/ different outcome+value) are conservatively SKIPPED.
//   Test 4 — Cleanup is idempotent (second run deletes nothing, no errors).
//   Test 5 — Empty/pending brief copy handler shows a message and copies nothing.
//
// Standalone, in-process, deterministic. Uses a throwaway temp DB and restores
// env on exit. Run: `node test-phase9-cleanup.js`

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

// Quiet logger so the [CLEANUP] chatter doesn't drown the test output. Capture
// lines so we can assert the migration logged what it did.
function capLogger() {
  const lines = [];
  return {
    lines,
    log:  (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push('WARN ' + a.join(' ')),
  };
}

async function main() {
  // ── temp prod DB ──
  const prevEnv  = process.env.NODE_ENV;
  const prevPath = process.env.DATABASE_PATH;
  const tmpFile  = path.join(os.tmpdir(), `nivaria-cleanup-test-${Date.now()}.db`);
  process.env.NODE_ENV     = 'production';
  process.env.DATABASE_PATH = tmpFile;

  const { initDb, getDb } = require('./src/db');
  const { removePhase9DemoData } = require('./src/db/migrations/remove-phase9-demo-data');

  await initDb();
  const db = getDb();

  // ── Test 1: production gate ──
  console.log('\nTest 1 — seedPhase9DemoData is gated out of production');
  const bootChanges = db.prepare('SELECT COUNT(*) AS n FROM changes').get().n;
  const bootDeals   = db.prepare('SELECT COUNT(*) AS n FROM deals').get().n;
  check('fresh production DB has 0 seeded changes', bootChanges === 0, `got ${bootChanges}`);
  check('fresh production DB has 0 seeded deals',   bootDeals === 0,   `got ${bootDeals}`);

  // ── seed a realistic post-leak production state ──
  // Real user + real competitors (Stripe lands at id 1, Linear at id 2 — exactly
  // the ids the buggy seed hardcodes).
  const userId = db.prepare("INSERT INTO users (email, name, tier, api_key) VALUES ('real@user.com','Real User','pro','cs-test')").run().lastInsertRowid;
  const stripeId = db.prepare("INSERT INTO competitors (user_id, name, url) VALUES (?, 'Stripe', 'https://stripe.com/changelog')").run(userId).lastInsertRowid;
  const linearId = db.prepare("INSERT INTO competitors (user_id, name, url) VALUES (?, 'Linear', 'https://linear.app/changelog')").run(userId).lastInsertRowid;

  const insChange = db.prepare(`INSERT INTO changes
    (competitor_id, analysis, threat_level, headline, analysis_status, is_meaningful, gate_category, pattern_tags, detected_at)
    VALUES (?, ?, ?, ?, 'ok', 1, ?, ?, ?)`);

  // Real Stripe brief — MUST survive.
  const realStripeChangeId = insChange.run(
    stripeId,
    JSON.stringify({ summary: 'Stripe shipped a genuine usage-based billing update.', threat_level: 'medium' }),
    'medium', 'Stripe ships usage-based billing v2', 'content_change', JSON.stringify(['feature_launch']),
    '2026-06-07 10:00:00').lastInsertRowid;

  // The 3 real demo changes (analysis contains the confirming marker) on the REAL
  // competitor ids — MUST be removed.
  const demoChg1 = insChange.run(stripeId,
    JSON.stringify({ summary: 'Acme reduced Pro pricing and introduced a low-cost entry tier.' }),
    'high', 'Acme Corp restructured pricing with an aggressive Pro discount', 'pricing_pattern', JSON.stringify(['pricing_change']),
    '2026-05-11 20:40:00').lastInsertRowid;
  const demoChg2 = insChange.run(stripeId,
    JSON.stringify({ summary: 'Acme dropped the per-seat ceiling on Pro.' }),
    'high', 'Acme Corp removed Pro seat caps', 'headings_changed', JSON.stringify(['plan_restructure']),
    '2026-05-25 20:40:00').lastInsertRowid;
  const demoChg3 = insChange.run(linearId,
    JSON.stringify({ summary: 'NovaTech entered our core feature territory with a beta launch.' }),
    'medium', 'NovaTech launched an AI writing assistant', 'content_change', JSON.stringify(['feature_launch']),
    '2026-05-19 20:40:00').lastInsertRowid;

  // TRAP: same headline as demoChg2 but NO marker in analysis → ambiguous, MUST be
  // skipped and survive.
  const trapChangeId = insChange.run(stripeId,
    JSON.stringify({ summary: 'A real, unrelated change that happens to share a headline.' }),
    'low', 'Acme Corp removed Pro seat caps', 'content_change', JSON.stringify([]),
    '2026-06-01 09:00:00').lastInsertRowid;

  // Demo deals (all 18) for the real user — MUST be removed.
  const insDeal = db.prepare(`INSERT INTO deals (user_id, deal_name, outcome, competitor_id, deal_value_usd, close_date, source)
    VALUES (?, ?, ?, ?, ?, '2026-06-01', 'manual_form')`);
  const DEMO = [
    ['Northwind Traders','lost',42000],['Globex Logistics','lost',38000],['Initech Platform','lost',55000],
    ['Soylent Foods','lost',27000],['Umbrella Health','lost',61000],['Vandelay Imports','lost',null],
    ['Stark Solutions','lost',48000],['Wayne Manufacturing','lost',33000],['Hooli Cloud','lost',72000],
    ['Pied Piper Data','lost',29000],['Cyberdyne Systems','stalled',36000],['Tyrell Corp','stalled',45000],
    ['Oscorp Labs','lost',31000],['Contoso Corp','won',25000],['Fabrikam Inc','won',40000],
    ['Adventure Works','won',52000],['Litware Group','won',18000],['Proseware','won',33000],
  ];
  for (const [n, o, v] of DEMO) insDeal.run(userId, n, o, stripeId, v);

  // Real deal — MUST survive.
  const realDealId = insDeal.run(userId, 'Globex Manufacturing (real)', 'won', stripeId, 12345).lastInsertRowid;
  // TRAP deal: same name as a demo deal but different outcome+value → MUST survive.
  const trapDealId = insDeal.run(userId, 'Proseware', 'lost', stripeId, 999).lastInsertRowid;

  // ── Test 2 + 3: run cleanup, assert only demo data removed ──
  console.log('\nTest 2/3 — cleanup removes only demo data, preserves real + ambiguous');
  const log = capLogger();
  const r = removePhase9DemoData(db, { force: true, log });

  check('removed exactly 3 demo changes', r.changes === 3, `got ${r.changes}`);
  check('removed exactly 18 demo deals',  r.deals === 18,  `got ${r.deals}`);
  check('removed 0 competitors (none in prod)', r.competitors === 0, `got ${r.competitors}`);
  check('skipped exactly 1 ambiguous change', r.skipped === 1, `got ${r.skipped}`);

  const exists = (sql, ...args) => !!db.prepare(sql).get(...args);
  check('demo change #1 deleted', !exists('SELECT id FROM changes WHERE id = ?', demoChg1));
  check('demo change #2 deleted', !exists('SELECT id FROM changes WHERE id = ?', demoChg2));
  check('demo change #3 deleted', !exists('SELECT id FROM changes WHERE id = ?', demoChg3));
  check('REAL Stripe brief preserved', exists('SELECT id FROM changes WHERE id = ?', realStripeChangeId));
  check('TRAP look-alike change preserved', exists('SELECT id FROM changes WHERE id = ?', trapChangeId));
  check('REAL competitors preserved (2)', db.prepare('SELECT COUNT(*) AS n FROM competitors').get().n === 2);
  check('REAL deal preserved', exists('SELECT id FROM deals WHERE id = ?', realDealId));
  check('TRAP deal (Proseware/lost/999) preserved', exists('SELECT id FROM deals WHERE id = ?', trapDealId));
  const remainingDemo = db.prepare("SELECT COUNT(*) AS n FROM deals WHERE deal_name IN ('Northwind Traders','Hooli Cloud','Contoso Corp')").get().n;
  check('no demo deals remain', remainingDemo === 0, `got ${remainingDemo}`);
  check('[CLEANUP] removal logged', log.lines.some(l => l.includes('[CLEANUP]') && l.includes('demo data removed')));

  // ── Test 4: idempotency ──
  console.log('\nTest 4 — second run is a safe no-op');
  const r2 = removePhase9DemoData(db, { force: true, log: capLogger() });
  check('second run removes 0 changes', r2.changes === 0, `got ${r2.changes}`);
  check('second run removes 0 deals',   r2.deals === 0,   `got ${r2.deals}`);
  check('TRAP change still present after re-run', exists('SELECT id FROM changes WHERE id = ?', trapChangeId));
  check('REAL deal still present after re-run',   exists('SELECT id FROM deals WHERE id = ?', realDealId));

  // ── Test 5: empty-brief copy handler ──
  console.log('\nTest 5 — copy handler handles empty/pending briefs gracefully');
  await testCopyHandler();

  // ── cleanup ──
  try { fs.unlinkSync(tmpFile); } catch {}
  process.env.NODE_ENV = prevEnv;
  if (prevPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prevPath;

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// Sandbox-load public/js/battlecard.js (a browser script) and drive BattleCard.copy
// with stubbed browser globals. We assert: a pending/empty brief shows the
// "not yet generated" toast and never reaches the clipboard; a full brief does.
async function testCopyHandler() {
  const src = fs.readFileSync(path.join(__dirname, 'public/js/battlecard.js'), 'utf8');

  const makeCtx = (change) => {
    const state = { toasts: [], shared: false };
    const sandbox = {
      window: {},
      console,
      API: { getChange: async () => change },
      toast: (msg) => state.toasts.push(msg),
      formatDate: () => 'today',
      shareOrCopy: async () => { state.shared = true; return 'clipboard'; },
      el: () => ({ innerHTML: '' }),
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return { BattleCard: sandbox.window.BattleCard, state };
  };

  // Pending brief — analysis_status not 'ok'.
  {
    const { BattleCard, state } = makeCtx({ id: 1, competitor_name: 'Stripe', competitor_url: 'https://stripe.com', analysis_status: 'pending', analysis: {} });
    await BattleCard.copy(1);
    check('pending brief shows "not yet generated" toast', state.toasts.some(t => /not yet generated/i.test(t)), JSON.stringify(state.toasts));
    check('pending brief does NOT copy to clipboard', state.shared === false);
  }
  // Empty brief — status ok but no body at all (would otherwise copy URL-only).
  {
    const { BattleCard, state } = makeCtx({ id: 2, competitor_name: 'Stripe', competitor_url: 'https://stripe.com/changelog', analysis_status: 'ok', analysis: {}, headline: '', talking_points: [] });
    await BattleCard.copy(2);
    check('empty brief shows "not yet generated" toast', state.toasts.some(t => /not yet generated/i.test(t)));
    check('empty brief does NOT copy URL-only to clipboard', state.shared === false);
  }
  // Full brief — must still copy normally.
  {
    const { BattleCard, state } = makeCtx({ id: 3, competitor_name: 'Stripe', competitor_url: 'https://stripe.com', analysis_status: 'ok',
      headline: 'Stripe ships X', threat_level: 'high',
      analysis: { summary: 'Real summary', recommended_response: 'Do this', talking_points: ['point a'] },
      talking_points: ['point a'] });
    await BattleCard.copy(3);
    check('full brief copies to clipboard', state.shared === true);
    check('full brief shows success toast', state.toasts.some(t => /copied|shared/i.test(t)));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
