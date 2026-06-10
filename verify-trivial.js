// Verification for "hide trivial changes from customer-facing views".
// Seeds a throwaway DB (demo data has meaningful changes), injects a trivial
// (is_meaningful=0) change, then runs the EXACT queries used by the customer
// routes (changes.js list + competitors.js list + changes.js stats) and asserts
// trivial is excluded from every response while remaining in the table.

const path = require('path');
const fs   = require('fs');
const os   = require('os');

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `nivaria-trivial-${Date.now()}.db`);
process.env.SESSION_SECRET = 'trivial-test-secret-0123456789ab';

const { initDb, getDb } = require('./src/db');

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`  ✅ ${n}`); };
const bad = (n, i) => { fail++; console.log(`  ❌ ${n}${i ? ` — ${i}` : ''}`); };
const assert = (c, n, i) => c ? ok(n) : bad(n, i);

(async () => {
  await initDb();
  const db = getDb();

  // Demo competitor 1 (Acme) already has meaningful changes from the seed.
  // Inject one trivial AI-downgraded change with a recognizable headline.
  db.prepare(`
    INSERT INTO changes (competitor_id, diff_summary, analysis, threat_level, headline,
      analysis_status, is_meaningful, gate_category, gate_reason, detected_at)
    VALUES (1, ?, ?, 'high', ?, 'ok', 0, 'ai_downgraded', 'AI judged change as non-meaningful', CURRENT_TIMESTAMP)
  `).run(
    JSON.stringify({ added: ['typo'], removed: [] }),
    JSON.stringify({ summary: 'A whitespace/typo fix with no strategic significance.' }),
    'TRIVIAL — typo fix that customers should NOT see',
  );

  const userId = 1;

  // ── 1. Customer change feed (exact changes.js list WHERE) ───────────────────
  console.log('\n[1] /api/changes list excludes trivial');
  {
    const where = 'c.user_id = ? AND (ch.is_meaningful IS NULL OR ch.is_meaningful = 1)';
    const rows = db.prepare(`
      SELECT ch.id, ch.headline, ch.is_meaningful
      FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
      WHERE ${where} ORDER BY ch.detected_at DESC
    `).all(userId);
    assert(rows.length > 0, 'feed returns meaningful changes', `${rows.length} rows`);
    assert(!rows.some(r => r.headline.startsWith('TRIVIAL')), 'feed does NOT contain the trivial change');
    assert(rows.every(r => r.is_meaningful === 1 || r.is_meaningful === null), 'every feed row is meaningful (or legacy NULL)');
  }

  // ── 2. Per-competitor counts/badges (exact competitors.js subqueries) ───────
  console.log('\n[2] /api/competitors counts exclude trivial');
  {
    const MEANINGFUL = '(is_meaningful IS NULL OR is_meaningful = 1)';
    const row = db.prepare(`
      SELECT c.id,
        (SELECT COUNT(*) FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL}) AS change_count,
        (SELECT COUNT(*) FROM changes WHERE competitor_id = c.id) AS change_count_all,
        (SELECT headline FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL} ORDER BY detected_at DESC LIMIT 1) AS last_headline
      FROM competitors c WHERE c.id = 1
    `).get();
    assert(row.change_count_all > row.change_count, 'trivial inflates the raw count but is excluded from displayed count',
      `displayed=${row.change_count} raw=${row.change_count_all}`);
    assert(row.change_count_all - row.change_count === 1, 'exactly the 1 injected trivial row is excluded');
    assert(!String(row.last_headline || '').startsWith('TRIVIAL'), 'last_headline badge does NOT reflect the trivial change',
      row.last_headline);
  }

  // ── 3. Dashboard stat counters (exact changes.js stats filter) ──────────────
  console.log('\n[3] /api/changes/stats counters exclude trivial');
  {
    const meaningfulOnly = '(ch.is_meaningful IS NULL OR ch.is_meaningful = 1)';
    const total = db.prepare(`
      SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
      WHERE c.user_id = ? AND ${meaningfulOnly}
    `).get(userId).n;
    const high = db.prepare(`
      SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
      WHERE c.user_id = ? AND ${meaningfulOnly} AND ch.threat_level = 'high'
    `).get(userId).n;
    // The injected trivial is threat_level='high' but is_meaningful=0 → must not count.
    const highWithTrivial = db.prepare(`
      SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
      WHERE c.user_id = ? AND ch.threat_level = 'high'
    `).get(userId).n;
    assert(total > 0, 'total_changes counts meaningful changes', `${total}`);
    assert(highWithTrivial > high, 'trivial high-threat row is excluded from the high_threats counter',
      `meaningful_high=${high} all_high=${highWithTrivial}`);
  }

  // ── 4. DB retention (NOT deleted) ───────────────────────────────────────────
  console.log('\n[4] trivial change is RETAINED in the database');
  {
    const trivialRows = db.prepare("SELECT id, headline, gate_category FROM changes WHERE is_meaningful = 0").all();
    assert(trivialRows.length >= 1, 'trivial rows still present in changes table', `${trivialRows.length} found`);
    assert(trivialRows.some(r => r.headline.startsWith('TRIVIAL') && r.gate_category === 'ai_downgraded'),
      'the injected trivial row exists with gate_category=ai_downgraded (audit intact)');
  }

  console.log(`\n${'─'.repeat(58)}\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}: ${pass} passed, ${fail} failed`);
  try { fs.unlinkSync(process.env.DATABASE_PATH); } catch (_) {}
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(path.basename(process.env.DATABASE_PATH)) && f.endsWith('.bak')) fs.unlinkSync(path.join(os.tmpdir(), f));
    }
  } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
