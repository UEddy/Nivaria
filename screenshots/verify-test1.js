// Test 1 verification — read-only DB checks + live gated-action probe + ngrok.
// Does NOT call initDb (no writes); opens the DB file read-only.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';

function openDbReadOnly() {
  return require('sql.js')().then((SQL) => {
    const p = path.join(__dirname, '..', 'data', 'competitor-shadow.db');
    return new SQL.Database(fs.readFileSync(p));
  });
}
const rows = (db, sql) => { const r = db.exec(sql); return r[0] ? r[0].values.map(v => Object.fromEntries(v.map((x, i) => [r[0].columns[i], x]))) : []; };

// minimal cookie-aware fetch
async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@nivaria.app', password: 'Demo1234!' }),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { ok: res.ok, cookie };
}

(async () => {
  const db = await openDbReadOnly();
  console.log('═══ STEP 1: payment_events ═══');
  const pe = rows(db, "SELECT id, lemon_squeezy_event_id, event_type, status, received_at, processed_at, error, workspace_id FROM payment_events WHERE event_type='subscription_created' ORDER BY id DESC LIMIT 3");
  if (!pe.length) console.log('  ❌ no subscription_created row found');
  pe.forEach(r => {
    console.log(`  event_type=${r.event_type} status=${r.status} processed_at=${r.processed_at || 'NULL'} error=${r.error || 'none'} ws=${r.workspace_id}`);
    console.log(`  lemon_squeezy_event_id=${String(r.lemon_squeezy_event_id).slice(0, 16)}…`);
  });
  const p1 = pe[0] && pe[0].status === 'processed' && pe[0].processed_at && !pe[0].error;
  console.log(`  STEP 1: ${p1 ? 'PASS ✅' : 'FAIL ❌'}`);

  console.log('\n═══ STEP 2: workspace #1 state ═══');
  const w = rows(db, 'SELECT subscription_id, subscription_status, subscription_tier, subscription_current_period_end, lemon_squeezy_customer_id, subscription_cancel_at_period_end FROM workspaces WHERE id=1')[0] || {};
  console.log(JSON.stringify(w, null, 2));
  const periodOk = w.subscription_current_period_end && (() => {
    const end = new Date(String(w.subscription_current_period_end).replace(' ', 'T')).getTime();
    const days = (end - Date.now()) / 86400000;
    return days > 20 && days < 45;
  })();
  const p2 = !!w.subscription_id && w.subscription_status === 'active' && w.subscription_tier === 'pro' && periodOk && !!w.lemon_squeezy_customer_id && Number(w.subscription_cancel_at_period_end) === 0;
  console.log(`  period_end ~1 month: ${periodOk ? 'yes' : 'NO'}; STEP 2: ${p2 ? 'PASS ✅' : 'FAIL ❌'}`);

  console.log('\n═══ STEP 3: audit_log ═══');
  const al = rows(db, "SELECT event_type, workspace_id, ip_hash, occurred_at FROM audit_log WHERE event_type='subscription_created' AND workspace_id=1 ORDER BY id DESC LIMIT 2");
  al.forEach(r => console.log(`  ${r.event_type} ws=${r.workspace_id} ip_hash=${r.ip_hash ? String(r.ip_hash).slice(0, 12) + '… (' + String(r.ip_hash).length + ' chars)' : 'NULL'} at=${r.occurred_at}`));
  const p3 = al.length > 0 && al[0].ip_hash && String(al[0].ip_hash).length === 64;
  console.log(`  STEP 3: ${p3 ? 'PASS ✅' : 'FAIL ❌'}`);

  console.log('\n═══ STEP 4: previously-gated action (set webhook URL) ═══');
  // NOTE: /api/settings validates webhook URL FORMAT before the tier gate, so an
  // arbitrary host (test.example.com) would 400 regardless of tier. Use a
  // valid-FORMAT Slack URL so the only thing that can reject it is the gate.
  // Host ends in .slack.com so it passes the server's webhook-format validation,
  // but deliberately omits the /services/T../B../token shape so secret scanners
  // don't flag this throwaway test value.
  const TEST_SLACK = 'https://gate-test.slack.com/webhook-format-check';
  let p4 = false;
  try {
    const { cookie } = await login();
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })).json();
    const csrf = me.csrfToken;
    const cur = await (await fetch(`${BASE}/api/settings`, { headers: { Cookie: cookie } })).json();
    const orig = cur.settings || {};
    const put = await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ slack_webhook: TEST_SLACK }),
    });
    console.log(`  PUT /api/settings (slack_webhook) → ${put.status} ${put.status === 200 ? '(was 402 when Free)' : ''}`);
    p4 = put.status === 200;
    // revert to original slack_webhook (null if it was empty)
    await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ slack_webhook: orig.slack_webhook || null }),
    });
    console.log(`  reverted slack_webhook to original (${orig.slack_webhook ? 'prior value' : 'null'})`);
  } catch (e) { console.log('  error:', e.message); }
  console.log(`  STEP 4: ${p4 ? 'PASS ✅' : 'FAIL ❌'}`);

  console.log('\n═══ STEP 5: ngrok inspector ═══');
  let p5 = false;
  try {
    const r = await fetch('http://127.0.0.1:4040/api/requests/http?limit=50');
    const j = await r.json();
    const hooks = (j.requests || []).filter(x => (x.request?.uri || '').includes('/api/webhooks/lemonsqueezy'));
    console.log(`  webhook POSTs seen by ngrok: ${hooks.length}`);
    hooks.slice(0, 3).forEach(h => console.log(`    ${h.request?.method} ${h.request?.uri} → ${h.response?.status_code}`));
    p5 = hooks.some(h => h.request?.method === 'POST' && h.response?.status_code === 200);
    console.log(`  STEP 5: ${p5 ? 'PASS ✅' : 'FAIL ❌ (no 200 POST found)'}`);
  } catch (e) {
    console.log(`  ngrok inspector not reachable at :4040 (${e.message}) — STEP 5: MANUAL CHECK NEEDED`);
  }

  console.log(`\n═══ TEST 1 OVERALL: ${[p1, p2, p3, p4].every(Boolean) ? 'PASS ✅ (steps 1-4)' : 'REVIEW ❌'} ; ngrok(step5)=${p5 ? 'PASS' : 'see note'} ═══`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
