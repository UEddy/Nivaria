// Test 13 — reconcile safety net. Simulates a permanently-dropped webhook by
// forcing demo (ws#1) into a "paid but shows Free" state (synthetic signed
// subscription_expired), then calls POST /api/billing/reconcile and confirms it
// restores state from Lemon Squeezy (source of truth) + logs an audit diff.
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
const j = (r) => r.json().catch(() => ({}));
const sign = (raw) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
function wsRow() {
  return require('sql.js')().then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
    const r = db.exec('SELECT subscription_id, subscription_status, subscription_tier, lemon_squeezy_customer_id FROM workspaces WHERE id=1');
    return r[0] ? Object.fromEntries(r[0].values[0].map((x, i) => [r[0].columns[i], x])) : {};
  });
}
function auditLatest() {
  return require('sql.js')().then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
    const r = db.exec("SELECT event_data FROM audit_log WHERE event_type='subscription_reconciled' AND workspace_id=1 ORDER BY id DESC LIMIT 1");
    return r[0] ? r[0].values[0][0] : null;
  });
}

(async () => {
  const checks = [];
  console.log('initial ws#1:', JSON.stringify(await wsRow()));

  // 1. Create drift: signed subscription_expired for the real subscription.
  const payload = JSON.stringify({ meta: { event_name: 'subscription_expired' }, data: { id: '2216012', attributes: { status: 'expired' } } });
  const exp = await j(await fetch(`${BASE}/api/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sign(payload) }, body: payload }));
  const drift = await wsRow();
  console.log('after synthetic expiry (drift):', JSON.stringify(drift));
  const drifted = drift.subscription_tier === 'free' && !drift.subscription_id;
  console.log(`  drift created (DB shows Free, LS still active): ${drifted ? '✅' : '❌'}`); checks.push(drifted);

  // 2. Reconcile (authenticated as demo).
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@nivaria.app', password: 'Demo1234!' }) });
  if (login.status === 429) { console.log('  ⚠ login rate-limited; cannot complete reconcile call'); process.exit(1); }
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const me = await j(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } }));
  const rec = await j(await fetch(`${BASE}/api/billing/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': me.csrfToken } }));
  console.log('reconcile response:', JSON.stringify(rec));
  checks.push(rec.reconciled === true && rec.tier === 'pro');

  // 3. Verify DB restored from LS.
  const after = await wsRow();
  console.log('after reconcile ws#1:', JSON.stringify(after));
  const restored = after.subscription_tier === 'pro' && String(after.subscription_id) === '2216012' && after.subscription_status === 'active';
  console.log(`  state restored from Lemon Squeezy: ${restored ? '✅' : '❌'}`); checks.push(restored);

  // 4. Audit diff.
  const diff = await auditLatest();
  console.log('subscription_reconciled audit diff:', diff);
  checks.push(!!diff && diff.includes('before') && diff.includes('after'));

  console.log(`\nTEST 13: ${checks.every(Boolean) ? 'PASS ✅ — reconcile corrects paid-but-shows-Free drift from Lemon Squeezy' : 'FAIL ❌'}`);
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
