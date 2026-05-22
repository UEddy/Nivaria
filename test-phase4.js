// Phase 4 test harness — meaningful-change gate.
//
// Pure unit tests on classifyChange + an end-to-end scenario through
// checkCompetitor that proves the gate actually suppresses the AI call.
// No network, no Playwright. Live AI calibration is separate (test-phase4-live.js).

process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-do-not-call';

const assert = require('assert');
const { classifyChange } = require('./src/changeGate');

const results = [];
function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, err) {
  const msg = err?.message || String(err);
  results.push({ name, ok: false, detail: msg });
  console.log(`  ❌ ${name} — ${msg}`);
}

// Build a content object matching scraper.fetchPageContent shape.
function content({ title = 'Acme — Pricing', metaDescription = 'desc', headings = ['Pricing', 'Plans', 'FAQ'], pricing = '', features = '', bodyText = '' } = {}) {
  return { title, metaDescription, ogTitle: '', headings, pricing, features, bodyText, scope: null };
}

function check(name, before, after, expectedMeaningful, expectedCategory) {
  const r = classifyChange(before, after, { isFirstCheck: false });
  try {
    assert.strictEqual(r.meaningful, expectedMeaningful, `expected meaningful=${expectedMeaningful} got ${r.meaningful}`);
    if (expectedCategory) {
      assert.strictEqual(r.category, expectedCategory, `expected category=${expectedCategory} got ${r.category}`);
    }
    pass(name, `${r.category}: ${r.reason}`);
  } catch (e) {
    fail(name, e);
  }
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Phase 4 — change-gate unit tests');
  console.log('══════════════════════════════════════════════════════════');

  // ── First observation: always meaningful ──────────────────────────────
  console.log('\n── First observation ──');
  try {
    const r = classifyChange(null, content({ bodyText: 'hello' }), { isFirstCheck: true });
    assert.strictEqual(r.meaningful, true);
    assert.strictEqual(r.category, 'first_seen');
    pass('first observation classified as meaningful');
  } catch (e) { fail('first observation', e); }

  // ── TRIVIAL: whitespace / case / punctuation only ─────────────────────
  console.log('\n── TRIVIAL: whitespace / case / punctuation only ──');

  check('whitespace shuffled',
    content({ bodyText: 'We help teams ship faster.\nLearn more today.' }),
    content({ bodyText: '  We  help teams  ship faster. Learn more today.  ' }),
    false, 'whitespace_or_case_only');

  check('case-only change',
    content({ bodyText: 'We help teams ship faster.' }),
    content({ bodyText: 'WE HELP TEAMS SHIP FASTER.' }),
    false, 'whitespace_or_case_only');

  check('punctuation-only change',
    content({ bodyText: 'Plans starting at affordable rates. Sign up today.' }),
    content({ bodyText: 'Plans starting at affordable rates! Sign up today!' }),
    false, 'whitespace_or_case_only');

  // ── TRIVIAL: date / time rollover ─────────────────────────────────────
  console.log('\n── TRIVIAL: date / time rollover ──');

  check('copyright year rollover',
    content({ bodyText: 'Trusted by 12000 teams. Copyright 2025 Acme Inc. All rights reserved. Built for modern workflows worldwide.' }),
    content({ bodyText: 'Trusted by 12000 teams. Copyright 2026 Acme Inc. All rights reserved. Built for modern workflows worldwide.' }),
    false, 'date_only');

  check('ISO date rollover',
    content({ bodyText: 'Last updated on 2025-11-04 by the Acme team. We continue improving every week with thoughtful releases.' }),
    content({ bodyText: 'Last updated on 2026-01-12 by the Acme team. We continue improving every week with thoughtful releases.' }),
    false, 'date_only');

  // ── TRIVIAL: small numeric counter change ─────────────────────────────
  console.log('\n── TRIVIAL: small numeric counter change ──');

  check('user counter ticking up',
    content({ bodyText: 'Trusted by 237 teams to make competitive decisions faster every single week.' }),
    content({ bodyText: 'Trusted by 241 teams to make competitive decisions faster every single week.' }),
    false, 'numeric_only');

  check('multiple counters, no currency',
    content({ bodyText: 'Used by 1000 companies across 45 countries to build better software at scale every day.' }),
    content({ bodyText: 'Used by 1050 companies across 47 countries to build better software at scale every day.' }),
    false, 'numeric_only');

  // ── TRIVIAL: meta description only ────────────────────────────────────
  console.log('\n── TRIVIAL: meta description only ──');

  check('meta description swap, body identical',
    content({ metaDescription: 'Foresight tracks competitors',          bodyText: 'Same body content here on the page.' }),
    content({ metaDescription: 'Foresight watches your competitors',    bodyText: 'Same body content here on the page.' }),
    false, 'meta_only');

  // ── MEANINGFUL: currency / pricing pattern delta ──────────────────────
  console.log('\n── MEANINGFUL: pricing / currency pattern delta ──');

  check('price reduction in body',
    content({ bodyText: 'Pro plan starts at $49 per month with unlimited features and great support.' }),
    content({ bodyText: 'Pro plan starts at $34 per month with unlimited features and great support.' }),
    true, 'pricing_pattern');

  check('new tier added in pricing section',
    content({ pricing: 'Pro plan $49/month. Team plan $99/month.', bodyText: 'See plans.' }),
    content({ pricing: 'Starter $9/month. Pro plan $49/month. Team plan $99/month.', bodyText: 'See plans.' }),
    true, 'pricing_pattern');

  check('discount percentage appears',
    content({ bodyText: 'Sign up today for our flexible plans that grow with your team.' }),
    content({ bodyText: 'Sign up today for our flexible plans. Save 30% off annual subscriptions.' }),
    true, 'pricing_pattern');

  check('euro pricing change',
    content({ pricing: 'Plans from €19 per month.' }),
    content({ pricing: 'Plans from €24 per month.' }),
    true, 'pricing_pattern');

  // ── MEANINGFUL: heading added / removed / renamed ─────────────────────
  console.log('\n── MEANINGFUL: heading set changed ──');

  check('new heading added',
    content({ headings: ['Pricing', 'Plans', 'FAQ'],                        bodyText: 'Same body.' }),
    content({ headings: ['Pricing', 'Plans', 'FAQ', 'Enterprise'],          bodyText: 'Same body.' }),
    true, 'headings_changed');

  check('heading removed',
    content({ headings: ['Pricing', 'Plans', 'FAQ', 'Roadmap'],             bodyText: 'Body.' }),
    content({ headings: ['Pricing', 'Plans', 'FAQ'],                        bodyText: 'Body.' }),
    true, 'headings_changed');

  check('heading renamed',
    content({ headings: ['Pricing', 'Plans', 'FAQ'],                        bodyText: 'Body.' }),
    content({ headings: ['Pricing', 'Tiers', 'FAQ'],                        bodyText: 'Body.' }),
    true, 'headings_changed');

  check('heading reorder is NOT meaningful (set-based comparison)',
    content({ headings: ['Plans', 'Pricing', 'FAQ'],                        bodyText: 'Same body content of substantial length here.' }),
    content({ headings: ['Pricing', 'FAQ', 'Plans'],                        bodyText: 'Same body content of substantial length here.' }),
    false, 'whitespace_or_case_only');

  // ── MEANINGFUL: word-count delta > 5% ─────────────────────────────────
  console.log('\n── MEANINGFUL: body text size delta > 5% ──');

  // 1000-char baseline, add 150 chars of new content (15% growth, well over 5%)
  // Avoid heading changes so we test the size path, not the heading path.
  const baseline1 = 'a'.repeat(1000);
  const expanded1 = baseline1 + ' This is genuinely new substantive marketing copy describing a freshly launched capability that customers will care about strongly today.';
  check('body text grew by ~15%',
    content({ bodyText: baseline1 }),
    content({ bodyText: expanded1 }),
    true, 'body_size_change');

  // 2% growth — should fall through to default meaningful, NOT body_size_change
  const small = baseline1 + ' twelve chars';
  const r2 = classifyChange(content({ bodyText: baseline1 }), content({ bodyText: small }), { isFirstCheck: false });
  try {
    assert.strictEqual(r2.meaningful, true, 'small change should default to meaningful');
    assert.notStrictEqual(r2.category, 'body_size_change', '2% growth should not trigger body_size_change');
    pass('body text grew by ~1% falls through to default meaningful', r2.category);
  } catch (e) { fail('small body delta default', e); }

  // ── REGRESSION: dollar in body must override otherwise-trivial pattern ──
  console.log('\n── REGRESSION: currency wins over trivial heuristics ──');

  check('numeric_only would match, but currency wins',
    content({ bodyText: 'We charge $49 per month for the Pro plan with unlimited seats and support.' }),
    content({ bodyText: 'We charge $34 per month for the Pro plan with unlimited seats and support.' }),
    true, 'pricing_pattern');

  check('date_only would match, but a new currency appears',
    content({ bodyText: 'Updated 2025-11-04. We help teams move faster every week with focused tooling.' }),
    content({ bodyText: 'Updated 2026-01-12. Pro $49/month. We help teams move faster every week with focused tooling.' }),
    true, 'pricing_pattern');

  // ── INTEGRATION: gate actually suppresses the AI in scheduler.checkCompetitor
  console.log('\n── INTEGRATION: gate short-circuits the AI ──');

  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const scraper  = require('./src/scraper');
    const analyzer = require('./src/analyzer');

    // Test double: if scheduler ever calls the AI, this throws and fails the test.
    let analyzerWasCalled = false;
    scraper.fetchPageContent = async () => {
      throw new Error('fetchPageContent should not be called by this test — checkCompetitor receives content from mocked fetch only');
    };
    analyzer.analyzeChange = async () => {
      analyzerWasCalled = true;
      throw new Error('AI MUST NOT BE CALLED for a gated-trivial diff');
    };

    const sqlDb = new SQL.Database();
    sqlDb.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, name TEXT, tier TEXT DEFAULT 'pro', api_key TEXT, session_version INTEGER DEFAULT 1);
      CREATE TABLE competitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT, url TEXT, description TEXT,
        active INTEGER DEFAULT 1, last_checked DATETIME, last_content_hash TEXT,
        last_check_status TEXT, last_check_error TEXT, last_check_at DATETIME,
        check_count INTEGER DEFAULT 0, render_mode TEXT DEFAULT 'fetch', css_selector TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, competitor_id INTEGER NOT NULL,
        content_before TEXT, content_after TEXT, diff_summary TEXT, analysis TEXT,
        threat_level TEXT, recommended_response TEXT, talking_points TEXT, headline TEXT,
        analysis_status TEXT DEFAULT 'ok', analysis_error TEXT,
        is_meaningful INTEGER DEFAULT 1, gate_category TEXT, gate_reason TEXT,
        ai_input_tokens INTEGER, ai_output_tokens INTEGER,
        pattern_tags TEXT, historical_context TEXT,
        detected_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE NOT NULL);
    `);
    function db() {
      return {
        prepare(sql) {
          return {
            run: (...args) => { sqlDb.run(sql, args.length ? args : undefined); const r = sqlDb.exec('SELECT last_insert_rowid()'); return { lastInsertRowid: Number(r[0]?.values[0][0] ?? 0) }; },
            get: (...args) => { const s = sqlDb.prepare(sql); try { if (args.length) s.bind(args); if (!s.step()) return undefined; return s.getAsObject(); } finally { s.free(); } },
            all: (...args) => { const s = sqlDb.prepare(sql); const rows = []; try { if (args.length) s.bind(args); while (s.step()) rows.push(s.getAsObject()); } finally { s.free(); } return rows; },
          };
        },
      };
    }
    const d = db();
    d.prepare('INSERT INTO users (email, name, tier, api_key) VALUES (?,?,?,?)').run('t@t', 'T', 'pro', 'cs-test');
    d.prepare('INSERT INTO settings (user_id) VALUES (?)').run(1);
    d.prepare('INSERT INTO competitors (user_id, name, url, last_content_hash) VALUES (?,?,?,?)')
      .run(1, 'GatedCo', 'https://gated.test', 'old_hash');
    const c = d.prepare('SELECT * FROM competitors WHERE id = 1').get();

    // Prior baseline: a content_after JSON the scheduler will read as `before`.
    const baseline = { title: 'GatedCo — Pricing', metaDescription: 'desc', ogTitle: '', headings: ['Pricing'], pricing: 'Pro $49', features: '', bodyText: 'Trusted by 237 teams. Copyright 2025 GatedCo Inc.', scope: null };
    d.prepare('INSERT INTO changes (competitor_id, content_after) VALUES (?, ?)').run(c.id, JSON.stringify(baseline));

    // Mock fetch to return content where only a year ticked over — a trivial diff.
    scraper.fetchPageContent = async () => ({
      content: { ...baseline, bodyText: 'Trusted by 237 teams. Copyright 2026 GatedCo Inc.' },
      hash: 'new_hash_gated',
      url: c.url,
      renderMode: 'fetch',
      renderDuration: 1,
    });

    const { checkCompetitor } = require('./src/scheduler');
    const r = await checkCompetitor(c, d);

    assert.strictEqual(r.ok, true,             'expected ok=true');
    assert.strictEqual(r.changed, true,        'expected changed=true (hash advanced)');
    assert.strictEqual(analyzerWasCalled, false, 'AI must NOT have been called');

    const rows = d.prepare('SELECT * FROM changes WHERE competitor_id = ? ORDER BY id DESC').all(c.id);
    const latest = rows[0];
    assert.strictEqual(latest.is_meaningful,  0,         'is_meaningful must be 0');
    assert.strictEqual(latest.analysis_status, 'trivial','analysis_status must be "trivial"');
    assert.strictEqual(latest.gate_category,   'date_only','gate_category must be "date_only"');
    assert.strictEqual(latest.ai_input_tokens,  null,    'no token usage recorded');
    assert.strictEqual(latest.ai_output_tokens, null,    'no token usage recorded');

    const fresh = d.prepare('SELECT * FROM competitors WHERE id = ?').get(c.id);
    assert.strictEqual(fresh.last_content_hash, 'new_hash_gated', 'baseline hash must still advance');
    assert.strictEqual(fresh.last_check_status, 'ok',             'competitor status remains "ok"');

    pass('gate suppresses AI for date-only diff: hash advanced, no analyzer call, row marked trivial');
  } catch (e) { fail('gate suppression integration', e); }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════\n');
  if (failed > 0) {
    console.log('Failures:');
    for (const r of results.filter(r => !r.ok)) console.log(`  • ${r.name}: ${r.detail}`);
    process.exit(1);
  }
})().catch(e => { console.error('Test harness crashed:', e); process.exit(1); });
