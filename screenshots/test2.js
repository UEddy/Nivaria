// Test 2 — cancel / resume flow (webhook-driven). Polls the RUNNING server's
// authoritative state via GET /api/billing/subscription (no DB file race).
// Usage: node screenshots/test2.js cancel    |    node screenshots/test2.js resume
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';

async function session() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@competitor-shadow.com', password: 'Demo1234!' }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}
const sub = (cookie) => fetch(`${BASE}/api/billing/subscription`, { headers: { Cookie: cookie } }).then(r => r.json());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function readAudit() {
  return require('sql.js')().then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
    const r = db.exec("SELECT event_type, occurred_at FROM audit_log WHERE workspace_id=1 AND event_type IN ('subscription_cancelled','subscription_resumed','subscription_updated') ORDER BY id DESC LIMIT 5");
    return r[0] ? r[0].values.map(v => `${v[0]} @ ${v[1]}`) : [];
  });
}

(async () => {
  const mode = process.argv[2];
  const { cookie, csrf } = await session();
  const before = await sub(cookie);
  console.log(`BEFORE: tier=${before.effectiveTier} status=${before.status} cancelAtPeriodEnd=${before.cancelAtPeriodEnd} periodEnd=${before.currentPeriodEnd}`);

  const ep = mode === 'cancel' ? '/api/billing/cancel' : '/api/billing/resume';
  const res = await fetch(`${BASE}${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf } });
  const body = await res.json().catch(() => ({}));
  console.log(`POST ${ep} → ${res.status} ${JSON.stringify(body)}`);

  const want = mode === 'cancel' ? (s) => s.cancelAtPeriodEnd === true : (s) => s.cancelAtPeriodEnd === false && s.status === 'active';
  let final = before, ok = false;
  for (let i = 0; i < 20; i++) {
    await sleep(4000);
    final = await sub(cookie);
    process.stdout.write(`  t+${(i + 1) * 4}s tier=${final.effectiveTier} status=${final.status} cancel=${final.cancelAtPeriodEnd}\n`);
    if (want(final)) { ok = true; break; }
  }

  console.log(`AFTER: tier=${final.effectiveTier} status=${final.status} cancelAtPeriodEnd=${final.cancelAtPeriodEnd} periodEnd=${final.currentPeriodEnd}`);
  const audit = await readAudit();
  console.log('audit (ws#1 sub events):', audit.join(' | ') || 'none');

  if (mode === 'cancel') {
    const stillPro = final.effectiveTier === 'pro';
    console.log(`\nTEST 2 (cancel): ${ok && stillPro ? 'PASS ✅ — cancel_at_period_end=true, access retained until ' + final.currentPeriodEnd : 'FAIL ❌'}`);
  } else {
    console.log(`\nTEST 2 (resume): ${ok ? 'PASS ✅ — cancellation undone, status active' : 'FAIL ❌'}`);
  }
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
