// Error-categorization test harness.
//
// Covers the work that splits the old single "blocked / SSRF" bucket into
// distinct, user-actionable failure modes:
//   1. classifyScrapeError maps each error shape → right error_type + message
//   2. A DNS NXDOMAIN is a DnsError, NOT an SsrfBlockedError (the regression
//      that made airdrop.citrea.xyz report "SSRF blocked")
//   3. The real SSRF guard is untouched: private IPs / localhost still blocked
//
// Tests 1–2 (assertHostIsPublic) do a real resolver query for a guaranteed-
// NXDOMAIN name (RFC 2606 .invalid TLD). Everything else is offline.

const assert  = require('assert');
const scraper = require('./src/scraper');
const {
  classifyScrapeError,
  assertHostIsPublic,
  DnsError,
  SsrfBlockedError,
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

// Build synthetic errors that mimic what each layer actually throws.
function nodeErr(code, message) { const e = new Error(message || code); e.code = code; return e; }
function httpErr(status)        { const e = new Error(`HTTP ${status}`); e.response = { status }; return e; }
function codedErr(code, extra)  { return Object.assign(new Error(code), { code }, extra || {}); }

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Error-categorization test harness');
  console.log('══════════════════════════════════════════════════════════');

  // ── 1. classifyScrapeError: one assertion per failure mode ───────────────
  console.log('\n── classifyScrapeError mapping ──');
  const url = 'https://example.test/page';
  const cases = [
    // [label, error, expected error_type, expected status, substring of human msg]
    ['real SSRF block',        codedErr('SSRF_BLOCKED', { reason: 'resolves to private IP 10.0.0.5' }), 'SSRF_BLOCKED', 'ssrf_blocked', 'private network address'],
    ['DnsError (NXDOMAIN)',    new DnsError('airdrop.citrea.xyz', 'ENOTFOUND'),                          'DNS_NXDOMAIN', 'dns_nxdomain', "doesn't exist"],
    ['raw getaddrinfo ENOTFOUND', nodeErr('ENOTFOUND', 'getaddrinfo ENOTFOUND foo.bar'),                'DNS_NXDOMAIN', 'dns_nxdomain', "doesn't exist"],
    ['Playwright name-not-resolved', codedErr('RENDER_FAILED', { message: 'net::ERR_NAME_NOT_RESOLVED at https://x' }), 'DNS_NXDOMAIN', 'dns_nxdomain', "doesn't exist"],
    ['connection refused',     nodeErr('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1'),             'CONNECTION_FAILED', 'connection_failed', "Couldn't connect"],
    ['axios timeout',          nodeErr('ECONNABORTED', 'timeout of 30000ms exceeded'),                  'CONNECTION_FAILED', 'connection_failed', "Couldn't connect"],
    ['host unreachable',       nodeErr('EHOSTUNREACH', 'connect EHOSTUNREACH'),                         'CONNECTION_FAILED', 'connection_failed', "Couldn't connect"],
    ['Playwright nav timeout', Object.assign(new Error('Timeout 30000ms exceeded'), { name: 'TimeoutError' }), 'CONNECTION_FAILED', 'connection_failed', "Couldn't connect"],
    ['Playwright conn refused',codedErr('RENDER_FAILED', { message: 'net::ERR_CONNECTION_REFUSED' }),    'CONNECTION_FAILED', 'connection_failed', "Couldn't connect"],
    ['HTTP 403',               httpErr(403),                                                            'ACCESS_DENIED', 'access_denied', 'rejected our request'],
    ['HTTP 401',               httpErr(401),                                                            'ACCESS_DENIED', 'access_denied', 'rejected our request'],
    ['HTTP 500',               httpErr(500),                                                            'SERVER_ERROR', 'server_error', 'server error'],
    ['HTTP 503',               httpErr(503),                                                            'SERVER_ERROR', 'server_error', 'server error'],
    ['HTTP 404',               httpErr(404),                                                            'HTTP_ERROR', 'http_error', '404'],
    ['HTTP 429',               httpErr(429),                                                            'HTTP_ERROR', 'http_error', '429'],
    ['anti-bot (Cloudflare)',  codedErr('BLOCKED_PAGE', { reason: 'Cloudflare challenge' }),            'ANTI_BOT', 'anti_bot', 'anti-bot protection'],
    ['JS-required wall → empty', codedErr('BLOCKED_PAGE', { reason: 'JavaScript-required wall (rendered shell only)' }), 'EMPTY_CONTENT', 'empty_content', 'JavaScript-heavy'],
    ['empty content',          codedErr('EMPTY_CONTENT', { reason: 'bodyText=12 chars' }),              'EMPTY_CONTENT', 'empty_content', 'JavaScript-heavy'],
    ['selector not found',     codedErr('SELECTOR_NOT_FOUND', { selector: '.price' }),                  'SELECTOR_NOT_FOUND', 'selector_not_found', '.price'],
    ['unknown error',          new Error('something weird'),                                            'UNKNOWN', 'fetch_failed', 'Something went wrong'],
  ];

  for (const [label, err, etype, status, sub] of cases) {
    try {
      const r = classifyScrapeError(err, url);
      assert.strictEqual(r.error_type, etype, `error_type: got ${r.error_type}`);
      assert.strictEqual(r.status, status, `status: got ${r.status}`);
      assert.ok(r.human.includes(sub), `human "${r.human}" should include "${sub}"`);
      assert.ok(r.technical.includes(etype), 'technical should embed the error_type for logs');
      // SSRF is the only mode allowed to mention "security".
      if (etype !== 'SSRF_BLOCKED') {
        assert.ok(!/security/i.test(r.human), `non-SSRF message must not mention security: "${r.human}"`);
      }
      pass(`classify: ${label}`, `${r.error_type} / "${r.human.slice(0, 48)}…"`);
    } catch (e) { fail(`classify: ${label}`, e); }
  }

  // ── 2. NXDOMAIN must be a DnsError, never SsrfBlockedError ────────────────
  console.log('\n── assertHostIsPublic: NXDOMAIN is NOT an SSRF block ──');
  try {
    await assertHostIsPublic('nonexistent-subdomain-xyz123.invalid');
    fail('NXDOMAIN → DnsError', new Error('expected a throw, got success'));
  } catch (err) {
    if (err instanceof DnsError && err.code === 'DNS_NXDOMAIN') {
      pass('NXDOMAIN → DnsError', `code=${err.code} dnsCode=${err.dnsCode}`);
    } else {
      fail('NXDOMAIN → DnsError', new Error(`expected DnsError, got ${err.name}/${err.code}: ${err.message}`));
    }
  }

  // ── 3. SSRF guard intact: private IPs + localhost still blocked ──────────
  console.log('\n── assertHostIsPublic: SSRF guard still fires ──');
  for (const host of ['192.168.1.1', '10.0.0.1', '172.16.5.5', '127.0.0.1', 'localhost', '169.254.169.254']) {
    try {
      await assertHostIsPublic(host);
      fail(`SSRF still blocks ${host}`, new Error('expected SsrfBlockedError, got success'));
    } catch (err) {
      if (err instanceof SsrfBlockedError && err.code === 'SSRF_BLOCKED') {
        pass(`SSRF still blocks ${host}`);
      } else {
        fail(`SSRF still blocks ${host}`, new Error(`expected SsrfBlockedError, got ${err.name}/${err.code}: ${err.message}`));
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
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
