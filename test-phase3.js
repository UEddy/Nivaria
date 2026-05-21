// Phase 3 test harness — Playwright JS renderer.
//
// What it covers:
//   1. SSRF rejection (localhost, 127.0.0.1, link-local 169.254.x, RFC1918)
//   2. Fetch-mode regression (existing axios+cheerio path unchanged)
//   3. Live JS render of modern SaaS pages (Notion, Linear, Stripe)
//   4. Global concurrency cap (max 3 Playwright contexts in flight)
//
// Most tests hit the real internet. Expect ~60s runtime.

const assert  = require('assert');
const scraper = require('./src/scraper');
const {
  fetchPageContent,
  _activeContexts,
  closeBrowser,
  isPrivateIp,
  PLAYWRIGHT_MAX_CONCURRENT_CONTEXTS,
} = scraper;

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

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Phase 3 — Playwright JS renderer test harness');
  console.log('══════════════════════════════════════════════════════════');

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── Pure isPrivateIp helper ──');
  try {
    assert.strictEqual(isPrivateIp('127.0.0.1'),       true,  '127.0.0.1');
    assert.strictEqual(isPrivateIp('10.0.0.1'),        true,  '10/8');
    assert.strictEqual(isPrivateIp('172.16.5.5'),      true,  '172.16/12');
    assert.strictEqual(isPrivateIp('172.31.255.255'),  true,  '172.31 edge');
    assert.strictEqual(isPrivateIp('172.32.0.1'),      false, '172.32 is public');
    assert.strictEqual(isPrivateIp('192.168.1.1'),     true,  '192.168/16');
    assert.strictEqual(isPrivateIp('169.254.169.254'), true,  'link-local AWS metadata');
    assert.strictEqual(isPrivateIp('8.8.8.8'),         false, 'public DNS');
    assert.strictEqual(isPrivateIp('::1'),             true,  'ipv6 loopback');
    assert.strictEqual(isPrivateIp('fc00::1'),         true,  'ipv6 ULA');
    assert.strictEqual(isPrivateIp('fd12::1'),         true,  'ipv6 ULA fd');
    assert.strictEqual(isPrivateIp('fe80::1'),         true,  'ipv6 link-local');
    assert.strictEqual(isPrivateIp('2001:4860:4860::8888'), false, 'ipv6 google DNS');
    assert.strictEqual(isPrivateIp('::ffff:127.0.0.1'),true,  'ipv4-mapped loopback');
    pass('isPrivateIp covers RFC1918, link-local, loopback, ULA, IPv4-mapped');
  } catch (e) { fail('isPrivateIp', e); }

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── SSRF block: navigation must be REJECTED in js mode ──');

  const ssrfTargets = [
    'http://localhost:3000/',
    'http://127.0.0.1:8080/',
    'http://169.254.169.254/latest/meta-data/',  // AWS instance metadata
    'http://10.0.0.1/',
    'http://192.168.1.1/admin',
    'http://172.16.5.5/',
  ];
  for (const url of ssrfTargets) {
    try {
      const r = await fetchPageContent(url, { renderMode: 'js' });
      fail(`SSRF block: ${url}`, new Error(`expected SSRF_BLOCKED, got success (body=${r.content.bodyText.length})`));
    } catch (err) {
      if (err && err.code === 'SSRF_BLOCKED') {
        pass(`SSRF block: ${url}`, err.message);
      } else {
        fail(`SSRF block: ${url}`, new Error(`expected SSRF_BLOCKED, got ${err.code || err.name}: ${err.message}`));
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── Fetch-mode regression (axios+cheerio path) ──');
  try {
    const r = await fetchPageContent('https://news.ycombinator.com/', { renderMode: 'fetch' });
    assert.strictEqual(r.renderMode, 'fetch', 'renderMode tag must be fetch');
    assert.ok(r.content.bodyText.length > 1000, `body too short: ${r.content.bodyText.length}`);
    assert.ok(r.content.title.length > 0,        'expected a title');
    assert.ok(typeof r.renderDuration === 'number' && r.renderDuration > 0, 'expected renderDuration');
    pass('fetch mode: HN renders unchanged', `body=${r.content.bodyText.length} chars, ${r.content.headings.length} headings, ${r.renderDuration}ms`);
  } catch (e) { fail('fetch mode: HN', e); }

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── Live JS render of modern SaaS pages ──');
  const liveSites = [
    ['https://www.notion.so/pricing', 'Notion pricing'],
    ['https://linear.app/',           'Linear homepage'],
    ['https://stripe.com/pricing',    'Stripe pricing'],
  ];
  for (const [url, label] of liveSites) {
    try {
      const r = await fetchPageContent(url, { renderMode: 'js' });
      assert.strictEqual(r.renderMode, 'js');
      const bodyLen  = r.content.bodyText.length;
      const headings = r.content.headings.length;
      // A real rendered page should yield substantial body content. Empty shells
      // would have thrown EmptyContentError before reaching here.
      assert.ok(bodyLen >= 500,  `body too short for a rendered page: ${bodyLen}`);
      pass(`JS render: ${label}`, `body=${bodyLen} chars, ${headings} headings, ${r.renderDuration}ms`);
    } catch (e) { fail(`JS render: ${label}`, e); }
  }

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── Concurrency cap (limit=' + PLAYWRIGHT_MAX_CONCURRENT_CONTEXTS + ') ──');
  // Fire 6 concurrent JS fetches against a stable public URL and poll
  // _activeContexts() to record max in-flight. Even if some fetches end up
  // throwing (e.g. empty content on a tiny page), the semaphore is acquired
  // before the work begins and released in finally — so concurrency
  // measurement is still valid.
  try {
    let maxObserved = 0;
    const poller = setInterval(() => {
      const n = _activeContexts();
      if (n > maxObserved) maxObserved = n;
    }, 20);

    const N = 6;
    const target = 'https://example.com/';
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () => fetchPageContent(target, { renderMode: 'js' }))
    );
    clearInterval(poller);

    const ok    = settled.filter(s => s.status === 'fulfilled').length;
    const empty = settled.filter(s => s.status === 'rejected' && s.reason?.code === 'EMPTY_CONTENT').length;
    const other = settled.filter(s => s.status === 'rejected' && s.reason?.code !== 'EMPTY_CONTENT');

    assert.ok(
      maxObserved <= PLAYWRIGHT_MAX_CONCURRENT_CONTEXTS,
      `max active contexts was ${maxObserved}, exceeds cap of ${PLAYWRIGHT_MAX_CONCURRENT_CONTEXTS}`
    );
    assert.ok(
      maxObserved >= 2,
      `concurrency probe only saw ${maxObserved} in-flight — semaphore may not be exercised`
    );
    pass(
      `concurrency cap holds`,
      `N=${N}, max observed=${maxObserved}, cap=${PLAYWRIGHT_MAX_CONCURRENT_CONTEXTS}, ok=${ok} empty=${empty} other=${other.length}`
    );
    if (other.length) {
      console.log(`     (non-empty rejections — informational): ${other.map(o => o.reason?.message || o.reason).join(' | ')}`);
    }
  } catch (e) { fail('concurrency cap', e); }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await closeBrowser();

  // ── Summary ─────────────────────────────────────────────────────────────
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
})().catch(e => {
  console.error('Test harness crashed:', e);
  process.exit(1);
});
