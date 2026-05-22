// Phase 5 test harness — historical pattern analysis.
//
// Verifies the temporal-context plumbing end-to-end without spending real
// Anthropic tokens. We mock the analyzer to inspect what it would have been
// asked, then assert the scheduler persists pattern_tags + historical_context.
//
// Also covers:
//   - tenant scoping (a second user cannot see competitor #1's history)
//   - empty-history case (no PRIOR CHANGES block, no awkward filler)
//   - cache hit / invalidation behavior
//   - pattern-callout generation
//   - prompt construction (history block presence/absence)

process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-do-not-call';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// Use a throwaway DB file so this test never touches the real one.
const TEST_DB_DIR = path.join(__dirname, 'data');
const REAL_DB     = path.join(TEST_DB_DIR, 'competitor-shadow.db');
const SAVED_DB    = path.join(TEST_DB_DIR, 'competitor-shadow.db.phase5-savepoint');

if (fs.existsSync(REAL_DB)) fs.copyFileSync(REAL_DB, SAVED_DB);
try { fs.unlinkSync(REAL_DB); } catch (_) {}

const results = [];
function pass(name, detail) { results.push({ name, ok: true,  detail }); console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, err)    { results.push({ name, ok: false, detail: err?.message || String(err) }); console.log(`  ❌ ${name} — ${err?.message || err}`); }

function restoreDb() {
  if (fs.existsSync(SAVED_DB)) {
    fs.copyFileSync(SAVED_DB, REAL_DB);
    fs.unlinkSync(SAVED_DB);
  } else {
    try { fs.unlinkSync(REAL_DB); } catch (_) {}
  }
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Phase 5 — historical pattern analysis');
  console.log('══════════════════════════════════════════════════════════');

  const { initDb, getDb } = require('./src/db');
  await initDb();
  const db = getDb();

  const {
    getCompetitorHistory,
    invalidateCompetitorHistory,
    formatHistoryForPrompt,
    generatePatternCallouts,
    _clearCacheForTests,
  } = require('./src/historicalContext');

  const analyzer  = require('./src/analyzer');
  const scraper   = require('./src/scraper');

  // ── Seed: user 1 has a competitor with 6 historical changes over 90 days,
  //    including 3 with pricing_change tag. User 2 has a separate competitor
  //    used to verify tenant scoping.
  const u2ApiKey = 'cs-test-u2-' + Date.now();
  db.prepare("INSERT INTO users (email, name, tier, api_key, password_hash, email_verified) VALUES (?, ?, 'pro', ?, 'x', 1)")
    .run('u2@test', 'U2', u2ApiKey);
  const u2 = db.prepare('SELECT * FROM users WHERE email = ?').get('u2@test');
  db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(u2.id);

  // Demo user from initDb is id=1.
  const seededCompId = db.prepare(
    "INSERT INTO competitors (user_id, name, url, description, render_mode) VALUES (1, 'PhasFiveCo', 'https://phasfive.test/pricing', 'Phase 5 fixture', 'fetch')"
  ).run().lastInsertRowid;

  const u2CompId = db.prepare(
    `INSERT INTO competitors (user_id, name, url, render_mode) VALUES (?, 'U2Co', 'https://u2.test/p', 'fetch')`
  ).run(u2.id).lastInsertRowid;

  // Seed history: most recent first, going back ~85 days.
  const daysAgo = (d) => `datetime('now', '-${d} days')`;
  const seedRow = ({ days, threat, headline, tags, changedWhat }) => {
    const analysisJson = JSON.stringify({
      is_meaningful: true,
      changed_what: changedWhat,
      why_it_matters: 'seeded for test',
      threat_level: threat,
      threat_reasoning: 'seeded',
      recommended_response: 'n/a',
      talking_points: [],
      headline,
      summary: changedWhat,
      key_changes: [],
      opportunity: '',
      pattern_tags: tags,
    });
    db.prepare(`
      INSERT INTO changes
        (competitor_id, threat_level, headline, analysis, pattern_tags, is_meaningful, detected_at)
      VALUES (?, ?, ?, ?, ?, 1, ${daysAgo(days)})
    `).run(seededCompId, threat, headline, analysisJson, JSON.stringify(tags));
  };

  seedRow({ days: 85, threat: 'high',   headline: 'PhasFiveCo cut Pro plan from $49 to $39',     tags: ['pricing_change'],                        changedWhat: 'Pro plan reduced from $49/mo to $39/mo' });
  seedRow({ days: 70, threat: 'medium', headline: 'PhasFiveCo launched AI assistant beta',         tags: ['feature_launch'],                        changedWhat: 'Beta AI writing assistant added to homepage' });
  seedRow({ days: 55, threat: 'high',   headline: 'PhasFiveCo added $9 Starter tier',              tags: ['pricing_change', 'plan_restructure'],    changedWhat: 'New $9/mo Starter tier added to pricing table' });
  seedRow({ days: 40, threat: 'medium', headline: 'PhasFiveCo enterprise messaging push',          tags: ['enterprise_push', 'positioning_shift'],  changedWhat: 'Homepage hero now leads with "Built for enterprise security teams"' });
  seedRow({ days: 25, threat: 'medium', headline: 'PhasFiveCo added SOC2 + HIPAA badges',          tags: ['certification', 'enterprise_push'],      changedWhat: 'Added SOC2 Type II and HIPAA compliance badges to footer' });
  seedRow({ days: 10, threat: 'medium', headline: 'PhasFiveCo enterprise case study added',        tags: ['enterprise_push'],                       changedWhat: 'New Fortune 500 enterprise case study published on customers page' });

  // ── 1. getCompetitorHistory: returns last 90 days, formatted, tenant-scoped
  console.log('\n── getCompetitorHistory ──');
  try {
    _clearCacheForTests();
    const h = getCompetitorHistory(seededCompId, { userId: 1 });
    assert.strictEqual(h.count, 6, 'should return all 6 seeded rows');
    assert.strictEqual(h.truncated, false, 'not truncated under 50 cap');
    assert.ok(h.formatted.includes('PRICING_') || h.formatted.includes('pricing_change'), 'format should include tag');
    assert.ok(/HIGH|MEDIUM/.test(h.formatted), 'format should include threat levels');
    pass('returns 6 changes with tags + formatted block', `${h.formatted.split('\n').length} lines`);
  } catch (e) { fail('getCompetitorHistory basic', e); }

  // ── 2. Tenant scoping: user 2 cannot read user 1's competitor history
  try {
    _clearCacheForTests();
    const cross = getCompetitorHistory(seededCompId, { userId: u2.id });
    assert.strictEqual(cross.count, 0, 'cross-tenant query must return zero rows');
    assert.strictEqual(cross.formatted, '', 'cross-tenant format must be empty');
    pass('tenant scoping blocks cross-user history access');
  } catch (e) { fail('tenant scoping', e); }

  // ── 3. Cache hit + explicit invalidation
  try {
    _clearCacheForTests();
    const a = getCompetitorHistory(seededCompId, { userId: 1 });
    assert.strictEqual(a.cacheHit, false, 'first call is a miss');
    const b = getCompetitorHistory(seededCompId, { userId: 1 });
    assert.strictEqual(b.cacheHit, true,  'second call is a hit');

    invalidateCompetitorHistory(seededCompId);
    const c = getCompetitorHistory(seededCompId, { userId: 1 });
    assert.strictEqual(c.cacheHit, false, 'after invalidation should miss again');
    pass('cache: hit on repeat, miss after invalidation');
  } catch (e) { fail('cache behavior', e); }

  // ── 4. Empty history: brand-new competitor returns empty format
  try {
    _clearCacheForTests();
    const emptyId = db.prepare("INSERT INTO competitors (user_id, name, url, render_mode) VALUES (1, 'EmptyCo', 'https://empty.test', 'fetch')").run().lastInsertRowid;
    const h = getCompetitorHistory(emptyId, { userId: 1 });
    assert.strictEqual(h.count, 0);
    assert.strictEqual(h.formatted, '', 'empty history must produce empty prompt block (no filler)');
    pass('empty history: no PRIOR CHANGES block emitted');
  } catch (e) { fail('empty history', e); }

  // ── 5. Prompt construction: history block present when non-empty, absent when empty
  console.log('\n── analyzer.buildPrompt ──');
  try {
    const competitor = { name: 'PhasFiveCo', url: 'https://phasfive.test/pricing', description: 'test' };
    const diff = {
      beforeTitle: 'Pricing', afterTitle: 'Pricing',
      beforeMeta: '', afterMeta: '',
      beforeHeadings: ['Pricing'], afterHeadings: ['Pricing'],
      beforePricing: 'Pro $39/mo', afterPricing: 'Pro $29/mo',
      beforeFeatures: '', afterFeatures: '',
      added: ['$29'], removed: ['$39'],
    };
    const withHist = analyzer.buildPrompt(competitor, diff,
      '- 2026-02-26 | HIGH [pricing_change] | Pro plan reduced from $49/mo to $39/mo');
    assert.ok(withHist.includes('PRIOR CHANGES (last 90 days)'), 'prompt must include PRIOR CHANGES section');
    assert.ok(withHist.includes('pricing_change'),               'prompt must include the tag verbatim');

    const noHist = analyzer.buildPrompt(competitor, diff, '');
    assert.ok(!noHist.includes('PRIOR CHANGES'), 'empty history must not insert PRIOR CHANGES header');
    pass('prompt builder includes history when present, omits when empty');
  } catch (e) { fail('buildPrompt', e); }

  // ── 6. END-TO-END: scheduler.checkCompetitor receives history, persists tags
  console.log('\n── scheduler end-to-end with mocked AI ──');
  try {
    let promptSeenByAI = null;
    let historyTextPassed = null;

    // Mock the analyzer — capture what it would have asked and return a realistic
    // response that references the seeded pricing history.
    analyzer.analyzeChange = async (comp, before, after, diff, historyText) => {
      historyTextPassed = historyText;
      promptSeenByAI = analyzer.buildPrompt(comp, diff, historyText);
      return {
        analysis: {
          is_meaningful: true,
          changed_what: 'Pro plan reduced from $39/mo to $29/mo and Starter tier dropped to $7/mo',
          why_it_matters: 'Third pricing cut in 90 days signals sustained margin pressure or aggressive land-grab.',
          threat_level: 'high',
          threat_reasoning: 'Pricing change directly affects live sales conversations.',
          recommended_response: 'Immediate sales briefing; pre-stage discount approvals for at-risk deals.',
          talking_points: ['Their third pricing cut in 90 days', 'Pattern suggests margin pressure'],
          headline: 'PhasFiveCo cuts Pro to $29 — third pricing change in 90 days',
          summary: 'PhasFiveCo cut Pro from $39 to $29/mo and Starter from $9 to $7/mo — the third pricing adjustment in the last 90 days, following the $49→$39 cut and the $9 Starter launch.',
          key_changes: [{ category: 'pricing', description: 'Pro $39 → $29, Starter $9 → $7', impact: 'Aggressive undercut continues' }],
          opportunity: 'Pricing instability is a sales objection — emphasize our stable, predictable pricing model.',
          historical_context: 'This is PhasFiveCo\'s third pricing change in 90 days following the $49→$39 cut and the $9 Starter tier launch. Combined with sustained enterprise messaging push, this looks like a deliberate squeeze of the mid-market from both ends.',
          pattern_tags: ['pricing_change', 'plan_restructure'],
        },
        usage: { input_tokens: 2400, output_tokens: 480 },
      };
    };

    // Stub the fetch so checkCompetitor uses our content.
    scraper.fetchPageContent = async () => ({
      content: {
        title: 'Pricing', metaDescription: '', ogTitle: '',
        headings: ['Pricing'], pricing: 'Pro $29/mo. Starter $7/mo.',
        features: '', bodyText: 'Pricing update.', scope: null,
      },
      hash: 'phase5-new-hash',
      url: 'https://phasfive.test/pricing',
      renderMode: 'fetch',
      renderDuration: 5,
    });

    // Set a prior baseline so the change-gate sees a real diff.
    const baseline = {
      title: 'Pricing', metaDescription: '', ogTitle: '',
      headings: ['Pricing'], pricing: 'Pro $39/mo. Starter $9/mo.',
      features: '', bodyText: 'Pricing.', scope: null,
    };
    db.prepare('INSERT INTO changes (competitor_id, content_after, detected_at) VALUES (?, ?, datetime(\'now\', \'-1 days\'))')
      .run(seededCompId, JSON.stringify(baseline));
    db.prepare('UPDATE competitors SET last_content_hash = ? WHERE id = ?').run('old-baseline-hash', seededCompId);

    const competitor = db.prepare('SELECT * FROM competitors WHERE id = ?').get(seededCompId);
    competitor.user_id = 1;

    // Re-require scheduler so it picks up our mocks (require cache is fine —
    // scheduler holds references to the modules, but its `analyzeChange` /
    // `fetchPageContent` are looked up via the module objects we just patched).
    const { checkCompetitor } = require('./src/scheduler');
    const r = await checkCompetitor(competitor, db);

    assert.strictEqual(r.ok, true,      'check should succeed');
    assert.strictEqual(r.changed, true, 'change should be detected');

    // History was actually passed to the analyzer
    assert.ok(typeof historyTextPassed === 'string' && historyTextPassed.length > 0,
      'analyzer must have been invoked with non-empty history text');
    assert.ok(historyTextPassed.includes('pricing_change'),
      'history must include the pricing_change tag from seeded rows');

    // Prompt actually contained the PRIOR CHANGES section
    assert.ok(promptSeenByAI.includes('PRIOR CHANGES'),
      'AI prompt must contain PRIOR CHANGES section');

    // Latest change row persisted pattern_tags + historical_context
    const latest = db.prepare(`SELECT * FROM changes WHERE competitor_id = ? ORDER BY detected_at DESC, id DESC LIMIT 1`).get(seededCompId);
    const tagsStored = JSON.parse(latest.pattern_tags || '[]');
    assert.deepStrictEqual(tagsStored, ['pricing_change', 'plan_restructure'], 'pattern_tags must be persisted');
    assert.ok(latest.historical_context && latest.historical_context.includes('third pricing change'),
      'historical_context must be persisted with the AI\'s narrative');

    pass('end-to-end: scheduler passes history → AI references it → tags + context persisted');
  } catch (e) { fail('scheduler end-to-end', e); }

  // ── 7. Pattern callout generation
  console.log('\n── generatePatternCallouts ──');
  try {
    _clearCacheForTests();
    const h = getCompetitorHistory(seededCompId, { userId: 1 });
    const callouts = generatePatternCallouts(h.changes);

    // After the end-to-end insert above we have 4 pricing_change tags and
    // 3 enterprise_push tags in the recent-5 window.
    const pricingCallout    = callouts.find(c => c.tag === 'pricing_change');
    const enterpriseCallout = callouts.find(c => c.tag === 'enterprise_push');

    assert.ok(pricingCallout, 'expected a pricing repeat callout');
    assert.ok(/\d+ pricing change/.test(pricingCallout.label), `pricing callout label shape: ${pricingCallout.label}`);

    assert.ok(enterpriseCallout, 'expected an enterprise trend callout');
    assert.strictEqual(enterpriseCallout.kind, 'trend');
    pass('callouts include pricing-repeat + enterprise-trend', callouts.map(c => c.label).join(' | '));
  } catch (e) { fail('callouts', e); }

  // ── 8. Empty-history callouts
  try {
    const none = generatePatternCallouts([]);
    assert.deepStrictEqual(none, [], 'empty history => no callouts');

    const single = generatePatternCallouts([
      { detected_at: '2026-05-01', threat_level: 'low', pattern_tags: ['feature_launch'] },
    ]);
    assert.strictEqual(single.length, 0, 'a single tagged change should not yield a "repeat" callout');
    pass('callouts handle empty + single-change cases gracefully');
  } catch (e) { fail('callouts empty cases', e); }

  // ── Summary
  console.log('\n══════════════════════════════════════════════════════════');
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════\n');

  restoreDb();

  if (failed > 0) {
    console.log('Failures:');
    for (const r of results.filter(r => !r.ok)) console.log(`  • ${r.name}: ${r.detail}`);
    process.exit(1);
  }
})().catch(e => { console.error('Test harness crashed:', e); restoreDb(); process.exit(1); });
