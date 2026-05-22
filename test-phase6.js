// Phase 6 test harness — contextual onboarding.
//
// Covers:
//   T1: existing user without context → analyzer runs context-less (no regression)
//   T2: user with saved context → analyzer prompt includes USER'S BUSINESS CONTEXT
//   T3: user updates context → next analysis sees the updated values
//   T4: tenant isolation — user A cannot read user B's context
//   T5: skip path — saving an empty form leaves no meaningful context; banner
//       semantics treat it as missing
//   T6: scheduler persists context_used=1 only when context was actually used
//
// Uses a throwaway DB. No live AI calls — analyzer is mocked to capture the
// prompt text and return a schema-valid response.

process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-do-not-call';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const REAL_DB  = path.join(__dirname, 'data', 'competitor-shadow.db');
const SAVED_DB = path.join(__dirname, 'data', 'competitor-shadow.db.phase6-savepoint');

if (fs.existsSync(REAL_DB)) fs.copyFileSync(REAL_DB, SAVED_DB);
try { fs.unlinkSync(REAL_DB); } catch (_) {}

const results = [];
function pass(name, detail) { results.push({ name, ok: true,  detail }); console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, err)    { results.push({ name, ok: false, detail: err?.message || String(err) }); console.log(`  ❌ ${name} — ${err?.message || err}`); }

function restore() {
  if (fs.existsSync(SAVED_DB)) {
    fs.copyFileSync(SAVED_DB, REAL_DB);
    fs.unlinkSync(SAVED_DB);
  }
}
process.on('uncaughtException', (e) => { console.error('Uncaught:', e); restore(); process.exit(1); });

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Phase 6 — contextual onboarding');
  console.log('══════════════════════════════════════════════════════════');

  const { initDb, getDb } = require('./src/db');
  await initDb();
  const db = getDb();

  const {
    getUserContext, saveUserContext, hasMeaningfulContext, formatContextForPrompt,
  } = require('./src/userContext');
  const analyzer = require('./src/analyzer');
  const scraper  = require('./src/scraper');

  // ── Set up: demo user is id=1 already. Add user B for isolation tests.
  db.prepare("INSERT INTO users (email, name, tier, api_key, password_hash, email_verified) VALUES (?, 'B', 'pro', ?, 'x', 1)")
    .run('b@test', 'cs-userb-' + Date.now());
  const userB = db.prepare("SELECT id FROM users WHERE email = ?").get('b@test');
  db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(userB.id);

  // ── T1: existing user (no context) runs analyzer context-less
  console.log('\n── T1: no context → analyzer runs without USER\'S BUSINESS CONTEXT ──');
  try {
    assert.strictEqual(getUserContext(1), null, 'demo user starts with no context');

    const competitor = { name: 'CompX', url: 'https://x.test', description: '' };
    const diff = { beforeTitle:'', afterTitle:'', beforeMeta:'', afterMeta:'',
                   beforeHeadings:[], afterHeadings:[], beforePricing:'', afterPricing:'',
                   beforeFeatures:'', afterFeatures:'', added:[], removed:[] };

    const ctx = getUserContext(1);
    const ctxText = formatContextForPrompt(ctx);
    const prompt = analyzer.buildPrompt(competitor, diff, '', ctxText);
    assert.ok(!prompt.includes("USER'S BUSINESS CONTEXT"), 'context block must be absent');
    pass('absent-context prompt has no USER\'S BUSINESS CONTEXT section');
  } catch (e) { fail('T1', e); }

  // ── T2: user saves context → analyzer prompt now includes it
  console.log('\n── T2: saved context → prompt includes USER\'S BUSINESS CONTEXT ──');
  try {
    const r = saveUserContext(1, {
      company_name: 'Foresight',
      what_we_sell: 'AI-generated competitor battle cards for B2B SaaS sales teams.',
      target_icp: 'B2B SaaS product marketing teams at 100-2000 employee companies.',
      our_positioning: 'Faster signal and sharper analysis than enterprise tools like Crayon.',
      typical_deal_size: 'mid',
      sales_motion: 'plg',
    });
    assert.strictEqual(r.ok, true);

    const ctx = getUserContext(1);
    assert.strictEqual(hasMeaningfulContext(ctx), true);

    const competitor = { name: 'CompX', url: 'https://x.test', description: '' };
    const diff = { beforeTitle:'', afterTitle:'', beforeMeta:'', afterMeta:'',
                   beforeHeadings:[], afterHeadings:[], beforePricing:'', afterPricing:'',
                   beforeFeatures:'', afterFeatures:'', added:[], removed:[] };

    const prompt = analyzer.buildPrompt(competitor, diff, '', formatContextForPrompt(ctx));
    assert.ok(prompt.includes("USER'S BUSINESS CONTEXT"), 'context section header present');
    assert.ok(prompt.includes('Company: Foresight'),        'company name appears');
    assert.ok(prompt.includes('mid-market'),                'deal-size label expanded in prompt');
    assert.ok(prompt.includes('PLG'),                       'sales motion label appears');
    pass('saved context appears in the analyzer prompt with expanded labels');
  } catch (e) { fail('T2', e); }

  // ── T3: update context → next prompt reflects new values
  console.log('\n── T3: update context → next prompt reflects new values ──');
  try {
    saveUserContext(1, { typical_deal_size: 'enterprise', sales_motion: 'slg' });
    const ctx = getUserContext(1);
    const block = formatContextForPrompt(ctx);
    assert.ok(block.includes('enterprise ($250K+ ACV)'), 'new deal size in block');
    assert.ok(block.includes('SLG (sales-led)'),         'new motion in block');
    assert.ok(!block.includes('PLG (product-led'),       'old motion replaced');
    pass('updated context shows up immediately in next prompt');
  } catch (e) { fail('T3', e); }

  // ── T4: tenant isolation
  console.log('\n── T4: tenant isolation ──');
  try {
    saveUserContext(userB.id, { company_name: 'UserB Co', what_we_sell: 'B stuff' });
    const a = getUserContext(1);
    const b = getUserContext(userB.id);
    assert.strictEqual(a.company_name, 'Foresight');
    assert.strictEqual(b.company_name, 'UserB Co');
    assert.notStrictEqual(a.user_id, b.user_id);
    pass('each user reads only their own context');
  } catch (e) { fail('T4', e); }

  // ── T5: skip path — empty/whitespace fields are treated as missing
  console.log('\n── T5: skip path → empty context is not "meaningful" ──');
  try {
    // userB clears everything (simulating "skip and edit later" then clearing)
    const r = saveUserContext(userB.id, {
      company_name: '', what_we_sell: '', target_icp: '', our_positioning: '',
      typical_deal_size: null, sales_motion: null,
    });
    assert.strictEqual(r.ok, true);
    const ctx = getUserContext(userB.id);
    assert.strictEqual(hasMeaningfulContext(ctx), false, 'cleared context must be classified as non-meaningful');
    assert.strictEqual(formatContextForPrompt(ctx), '', 'empty context yields empty prompt block');
    pass('skip/clear path: no PRIOR USER context emitted, banner would re-appear');
  } catch (e) { fail('T5', e); }

  // ── T6: scheduler persists context_used flag correctly
  console.log('\n── T6: scheduler persists context_used ──');
  try {
    // Mock analyzer + fetcher. Capture whether userContextText was non-empty.
    let receivedCtxText = null;
    analyzer.analyzeChange = async (comp, before, after, diff, history, userContextText) => {
      receivedCtxText = userContextText;
      return {
        analysis: {
          is_meaningful: true, changed_what: 'Pro $49 → $29', why_it_matters: 'price cut',
          threat_level: 'high', threat_reasoning: 'price affects sales',
          recommended_response: 'brief sales', talking_points: ['x'],
          headline: 'price cut', summary: 'price cut',
          key_changes: [{ category:'pricing', description:'$49→$29', impact:'undercut' }],
          opportunity: '',
          historical_context: '', pattern_tags: ['pricing_change'],
        },
        usage: { input_tokens: 1500, output_tokens: 400 },
      };
    };
    scraper.fetchPageContent = async () => ({
      content: { title:'Pricing', metaDescription:'', ogTitle:'', headings:['Pricing'],
                 pricing:'Pro $29', features:'', bodyText:'.', scope:null },
      hash: 'new', url:'https://x.test', renderMode:'fetch', renderDuration:1,
    });

    // Competitor for user 1 (who has context)
    const c1Id = db.prepare(
      "INSERT INTO competitors (user_id, name, url, render_mode, last_content_hash) VALUES (1, 'CtxComp', 'https://x.test/p', 'fetch', 'old-hash-1')"
    ).run().lastInsertRowid;
    db.prepare("INSERT INTO changes (competitor_id, content_after, detected_at) VALUES (?, ?, datetime('now', '-1 days'))")
      .run(c1Id, JSON.stringify({ title:'Pricing', metaDescription:'', ogTitle:'', headings:['Pricing'], pricing:'Pro $49', features:'', bodyText:'.', scope:null }));

    // Competitor for user B (no context — we cleared it in T5)
    const cBId = db.prepare(
      `INSERT INTO competitors (user_id, name, url, render_mode, last_content_hash) VALUES (?, 'BareComp', 'https://x.test/q', 'fetch', 'old-hash-2')`
    ).run(userB.id).lastInsertRowid;
    db.prepare("INSERT INTO changes (competitor_id, content_after, detected_at) VALUES (?, ?, datetime('now', '-1 days'))")
      .run(cBId, JSON.stringify({ title:'Pricing', metaDescription:'', ogTitle:'', headings:['Pricing'], pricing:'Pro $49', features:'', bodyText:'.', scope:null }));

    const c1 = db.prepare('SELECT * FROM competitors WHERE id = ?').get(c1Id);
    const cB = db.prepare('SELECT * FROM competitors WHERE id = ?').get(cBId);

    const { checkCompetitor } = require('./src/scheduler');

    await checkCompetitor(c1, db);
    assert.ok(receivedCtxText && receivedCtxText.includes('Company: Foresight'),
      'analyzer should have received the user-1 context text');

    receivedCtxText = null;
    await checkCompetitor(cB, db);
    assert.strictEqual(receivedCtxText || '', '',
      'analyzer should have received empty context for user B (no context saved)');

    // Verify persisted flags
    const r1 = db.prepare('SELECT context_used FROM changes WHERE competitor_id = ? ORDER BY id DESC LIMIT 1').get(c1Id);
    const rB = db.prepare('SELECT context_used FROM changes WHERE competitor_id = ? ORDER BY id DESC LIMIT 1').get(cBId);
    assert.strictEqual(r1.context_used, 1, 'user-1 change must record context_used=1');
    assert.strictEqual(rB.context_used, 0, 'user-B change must record context_used=0');
    pass('scheduler: context_used=1 only when context was actually injected');
  } catch (e) { fail('T6', e); }

  // ── Summary
  console.log('\n══════════════════════════════════════════════════════════');
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════\n');

  restore();
  if (failed > 0) {
    console.log('Failures:');
    for (const r of results.filter(r => !r.ok)) console.log(`  • ${r.name}: ${r.detail}`);
    process.exit(1);
  }
})().catch(e => { console.error('Test harness crashed:', e); restore(); process.exit(1); });
