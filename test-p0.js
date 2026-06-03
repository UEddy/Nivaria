// End-to-end test for the four P0 engine correctness fixes.
// We force ANTHROPIC_API_KEY = 'sk-ant-test' so scheduler takes the AI branch.
// The analyzer is monkey-patched anyway, so no real network call happens.
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-do-not-call';
//
// Strategy:
//   1. Build a fresh in-memory sql.js DB with the production schema (incl. P0 columns).
//   2. Monkey-patch scraper.fetchPageContent + analyzer.analyzeChange BEFORE
//      scheduler is required, so scheduler captures our test doubles.
//   3. Drive each scenario through the real checkCompetitor() and assert against the DB.

const assert = require('assert');

(async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  // ── Test double registers ──────────────────────────────────────────────────
  let nextFetchResult = null;
  let nextFetchError  = null;
  let nextAnalyzeResult = null;
  let nextAnalyzeError  = null;

  // Install test doubles into the scraper and analyzer module exports BEFORE
  // requiring scheduler — scheduler destructures at require-time.
  const scraper = require('./src/scraper');
  const analyzer = require('./src/analyzer');

  scraper.fetchPageContent = async () => {
    if (nextFetchError) throw nextFetchError;
    return nextFetchResult;
  };
  // Phase 4: analyzeChange now returns { analysis, usage }. Wrap the test
  // double so the scheduler can still destructure cleanly.
  analyzer.analyzeChange = async () => {
    if (nextAnalyzeError) throw nextAnalyzeError;
    return { analysis: nextAnalyzeResult, usage: null };
  };

  const { checkCompetitor } = require('./src/scheduler');
  // Reuse real error classes
  const { BlockedPageError, EmptyContentError, detectBlockPage, detectEmptyContent, detectJsWall } = scraper;
  const { AIAnalysisError, buildFallbackAnalysis } = analyzer;

  // ── In-memory DB with the same shape as production ────────────────────────
  const sqlDb = new SQL.Database();
  sqlDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT, name TEXT, tier TEXT DEFAULT 'pro', api_key TEXT,
      session_version INTEGER DEFAULT 1
    );
    CREATE TABLE competitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL, url TEXT NOT NULL, description TEXT,
      active INTEGER DEFAULT 1,
      last_checked DATETIME, last_content_hash TEXT,
      last_check_status TEXT, last_check_error TEXT, last_check_at DATETIME,
      check_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competitor_id INTEGER NOT NULL,
      content_before TEXT, content_after TEXT, diff_summary TEXT,
      analysis TEXT, threat_level TEXT, recommended_response TEXT,
      talking_points TEXT, headline TEXT,
      analysis_status TEXT DEFAULT 'ok', analysis_error TEXT,
      is_meaningful INTEGER DEFAULT 1, gate_category TEXT, gate_reason TEXT,
      ai_input_tokens INTEGER, ai_output_tokens INTEGER,
      detected_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE NOT NULL);
  `);

  // Better-sqlite3-style wrapper for the test, matching what scheduler expects
  function makeDb() {
    return {
      prepare(sql) {
        return {
          run: (...args) => {
            sqlDb.run(sql, args.length ? args : undefined);
            const r = sqlDb.exec('SELECT last_insert_rowid()');
            return { lastInsertRowid: Number(r[0]?.values[0][0] ?? 0) };
          },
          get: (...args) => {
            const stmt = sqlDb.prepare(sql);
            try {
              if (args.length) stmt.bind(args);
              if (!stmt.step()) return undefined;
              return stmt.getAsObject();
            } finally { stmt.free(); }
          },
          all: (...args) => {
            const stmt = sqlDb.prepare(sql);
            const rows = [];
            try {
              if (args.length) stmt.bind(args);
              while (stmt.step()) rows.push(stmt.getAsObject());
            } finally { stmt.free(); }
            return rows;
          },
        };
      }
    };
  }
  const db = makeDb();

  db.prepare('INSERT INTO users (email, name, tier, api_key) VALUES (?,?,?,?)')
    .run('t@test.local', 'Tester', 'pro', 'cs-test');
  db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(1);

  function seedCompetitor(name, prevHash) {
    db.prepare('INSERT INTO competitors (user_id, name, url, last_content_hash) VALUES (?,?,?,?)')
      .run(1, name, 'https://example.test/' + name, prevHash || null);
    return db.prepare('SELECT * FROM competitors WHERE name = ?').get(name);
  }

  function reloadCompetitor(id) {
    return db.prepare('SELECT * FROM competitors WHERE id = ?').get(id);
  }
  function changesFor(id) {
    return db.prepare('SELECT * FROM changes WHERE competitor_id = ? ORDER BY detected_at DESC').all(id);
  }

  // Suppress noisy expected error logs while still surfacing real failures
  const origErr = console.error;
  console.error = () => {};

  const results = [];
  function pass(name, detail) { results.push({ name, ok: true,  detail }); console.log(`  ✅ ${name}`); }
  function fail(name, err)    { results.push({ name, ok: false, detail: err.message }); console.log(`  ❌ ${name} — ${err.message}`); }

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n── Pure detection helpers ─────────────────────────────────────');

  try {
    assert.strictEqual(detectBlockPage('<html><body>Just a moment...<br>Cloudflare</body></html>'), 'Cloudflare challenge');
    assert.strictEqual(detectBlockPage('<html><script src="dd.js"></script></html>'), 'DataDome challenge');
    assert.strictEqual(detectBlockPage('<html>Sorry, you have been blocked</html>'), 'DataDome block');
    assert.strictEqual(detectBlockPage('<html><body><h1>Hello</h1></body></html>'), null);
    pass('detectBlockPage recognizes Cloudflare/DataDome and ignores normal HTML');
  } catch (e) { fail('detectBlockPage', e); }

  try {
    assert.deepStrictEqual(
      typeof detectEmptyContent({ bodyText: '', headings: [], title: '' }),
      'string'
    );
    assert.strictEqual(
      detectEmptyContent({ bodyText: 'x'.repeat(500), headings: [], title: '' }),
      null
    );
    assert.strictEqual(
      detectEmptyContent({ bodyText: '', headings: ['only one'], title: '' }),
      null
    );
    pass('detectEmptyContent flags empty-shell but not partially-empty');
  } catch (e) { fail('detectEmptyContent', e); }

  try {
    const jsWallHtml = '<html><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>';
    assert.ok(detectJsWall(jsWallHtml, { bodyText: 'You need to enable JavaScript to run this app.' }));
    assert.strictEqual(detectJsWall('<html>normal</html>', { bodyText: 'x'.repeat(1000) }), null);
    pass('detectJsWall flags JS-required walls with sparse bodies');
  } catch (e) { fail('detectJsWall', e); }

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n── BUG 3: anti-bot page → status=\'anti_bot\', no hash update ────');

  try {
    const c = seedCompetitor('blocked-target', 'old_hash_BLOCKED');
    nextFetchError = new BlockedPageError('Cloudflare challenge', c.url);
    const r = await checkCompetitor(c, db);

    assert.strictEqual(r.ok, false, 'expected ok=false');
    // A Cloudflare bot-challenge now classifies as an anti-bot block (was the
    // generic 'blocked'). The stored message is user-facing; the technical
    // "Cloudflare challenge" reason goes to the logs only.
    assert.strictEqual(r.status, 'anti_bot', 'expected status=anti_bot');

    const fresh = reloadCompetitor(c.id);
    assert.strictEqual(fresh.last_check_status, 'anti_bot', 'last_check_status not anti_bot');
    assert.ok(fresh.last_check_error && fresh.last_check_error.includes('anti-bot'), 'human anti-bot message missing');
    assert.strictEqual(fresh.last_content_hash, 'old_hash_BLOCKED', 'hash must NOT advance on block');
    assert.strictEqual(changesFor(c.id).length, 0, 'no change row should be inserted');
    pass('anti-bot page: hash preserved, status surfaced, no change row');
  } catch (e) { fail('anti-bot page handling', e); }

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n── BUG 2: empty content → status=\'empty_content\', no hash update');

  try {
    const c = seedCompetitor('empty-target', 'old_hash_EMPTY');
    nextFetchError = new EmptyContentError('bodyText=12 chars, headings=0, title=""', c.url);
    const r = await checkCompetitor(c, db);

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'empty_content');

    const fresh = reloadCompetitor(c.id);
    assert.strictEqual(fresh.last_check_status, 'empty_content');
    // last_check_error now holds the user-facing message, not the raw
    // "bodyText=…" technical detail (that goes to the logs).
    assert.ok(fresh.last_check_error.includes('extract content'));
    assert.strictEqual(fresh.last_content_hash, 'old_hash_EMPTY', 'hash must NOT advance on empty content');
    assert.strictEqual(changesFor(c.id).length, 0);
    pass('empty content: hash preserved, status surfaced, no change row');
  } catch (e) { fail('empty content handling', e); }

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n── BUG 1: analyzer throws → change still stored + hash advances ─');

  try {
    const c = seedCompetitor('analyzer-throws', 'old_hash_ANA');
    nextFetchError = null;
    nextFetchResult = {
      url: c.url,
      hash: 'new_hash_ANA',
      content: { title: 'New Title', metaDescription: 'm', ogTitle: '', headings: ['Hello'], pricing: '', features: '', bodyText: 'x'.repeat(800) },
    };
    nextAnalyzeError = new AIAnalysisError('ai_out_of_credits', 'Anthropic account is out of credits.');
    nextAnalyzeResult = null;

    const r = await checkCompetitor(c, db);

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'ok_ai_out_of_credits');
    assert.strictEqual(r.changed, true);

    const fresh = reloadCompetitor(c.id);
    assert.strictEqual(fresh.last_content_hash, 'new_hash_ANA', 'hash MUST advance even when analyzer fails');
    assert.strictEqual(fresh.last_check_status, 'ok_ai_out_of_credits');
    assert.ok(fresh.last_check_error && fresh.last_check_error.includes('out of credits'));

    const changes = changesFor(c.id);
    assert.strictEqual(changes.length, 1, 'exactly one change row expected');
    assert.strictEqual(changes[0].analysis_status, 'failed', 'change row must be flagged as failed for backfill');
    assert.ok(changes[0].analysis_error && changes[0].analysis_error.includes('out of credits'));
    // Fallback analysis was stored so the UI is not empty
    const stored = JSON.parse(changes[0].analysis);
    assert.ok(stored.headline && stored.threat_level, 'fallback analysis must populate threat/headline');

    pass('analyzer failure: change row inserted (analysis_status=failed), hash advanced, fallback stored');
  } catch (e) { fail('analyzer try/catch', e); }

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n── BUG 4: missing API key → fallback used, change stored ──────');

  try {
    const c = seedCompetitor('no-key', 'old_hash_KEY');
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = '';

    nextFetchError = null;
    nextFetchResult = {
      url: c.url,
      hash: 'new_hash_KEY',
      content: { title: 'T', metaDescription: '', ogTitle: '', headings: ['H'], pricing: 'P', features: 'F', bodyText: 'b'.repeat(500) },
    };
    nextAnalyzeError = new Error('SHOULD NEVER BE CALLED — key is missing so scheduler must skip analyzer');
    nextAnalyzeResult = null;

    const r = await checkCompetitor(c, db);
    process.env.ANTHROPIC_API_KEY = savedKey;

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'ok_no_ai_key');
    assert.strictEqual(r.changed, true);

    const fresh = reloadCompetitor(c.id);
    assert.strictEqual(fresh.last_content_hash, 'new_hash_KEY');
    assert.strictEqual(fresh.last_check_status, 'ok_no_ai_key');
    assert.ok(fresh.last_check_error && fresh.last_check_error.includes('ANTHROPIC_API_KEY'));

    const changes = changesFor(c.id);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].analysis_status, 'failed');
    const stored = JSON.parse(changes[0].analysis);
    assert.ok(stored.headline && stored.summary);

    pass('no AI key: fallback analysis stored, change row flagged for backfill');
  } catch (e) { fail('no API key handling', e); }

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n── BUG 4: error categorization (401/402/429/5xx) ───────────────');

  try {
    const { categorizeAnthropicError } = analyzer;
    const cases = [
      [{ status: 401, message: 'unauthorized' }, 'ai_auth_failed'],
      [{ message: 'authentication_error: invalid x-api-key' }, 'ai_auth_failed'],
      [{ status: 402, message: 'payment required' }, 'ai_out_of_credits'],
      [{ message: 'Your credit balance is too low. Visit Plans & Billing.' }, 'ai_out_of_credits'],
      [{ status: 429, message: 'rate_limit' }, 'ai_rate_limited'],
      [{ status: 500, message: 'server error' }, 'ai_service_error'],
      [{ status: 503, message: 'unavailable' }, 'ai_service_error'],
      [{ message: 'network down' }, 'ai_error'],
    ];
    for (const [input, expected] of cases) {
      const out = categorizeAnthropicError(input);
      assert.strictEqual(out.code, expected, `expected ${expected} for ${JSON.stringify(input)} but got ${out.code}`);
    }
    pass(`categorizeAnthropicError handles ${cases.length} distinct cases`);
  } catch (e) { fail('error categorization', e); }

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n── Successful happy path (regression guard) ───────────────────');

  try {
    const c = seedCompetitor('happy', 'old_hash_HAPPY');
    nextFetchError = null;
    nextFetchResult = {
      url: c.url,
      hash: 'new_hash_HAPPY',
      content: { title: 'New', metaDescription: '', ogTitle: '', headings: ['H1'], pricing: '', features: '', bodyText: 'y'.repeat(900) },
    };
    nextAnalyzeError = null;
    nextAnalyzeResult = {
      headline: 'Real AI card', summary: 'real', threat_level: 'medium',
      threat_reasoning: 'r', recommended_response: 'do x',
      talking_points: ['a','b'], key_changes: [{ category:'pricing', description:'d', impact:'i' }],
      opportunity: 'op',
    };
    const r = await checkCompetitor(c, db);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'ok');

    const changes = changesFor(c.id);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].analysis_status, 'ok');
    assert.strictEqual(changes[0].analysis_error, null);

    const fresh = reloadCompetitor(c.id);
    assert.strictEqual(fresh.last_content_hash, 'new_hash_HAPPY');
    assert.strictEqual(fresh.last_check_status, 'ok');
    pass('happy path: status=ok, change stored, hash advanced');
  } catch (e) { fail('happy path', e); }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.error = origErr;
  console.log('\n══════════════════════════════════════════════════════════');
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════');
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results.filter(r => !r.ok)) console.log(`  • ${r.name}: ${r.detail}`);
    process.exit(1);
  }
})().catch(e => { console.error('Test harness crashed:', e); process.exit(1); });
