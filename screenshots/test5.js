// Test 5 — tier enforcement on a fresh FREE workspace. Registers a throwaway
// (using the register/complete session cookie — no login, dodges that limiter),
// hits each Pro-gated endpoint, expects 402 upgrade_required, and confirms
// gate_violation audit rows. Saves creds+cookie to .throwaway.json for Test 11.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const EMAIL = `qa-t5-${Date.now()}@foresight.test`;
const PASSWORD = 'QaThrow!2026xZ';
const j = (r) => r.json().catch(() => ({}));
function readDb(sql) {
  return require('sql.js')().then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
    const r = db.exec(sql);
    return r[0] ? r[0].values.map(v => Object.fromEntries(v.map((x, i) => [r[0].columns[i], x]))) : [];
  });
}

(async () => {
  // ── register throwaway ──
  await fetch(`${BASE}/api/auth/register/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, consent: true }) });
  const otp = (await readDb(`SELECT code FROM otp_codes WHERE email='${EMAIL}' AND used=0 ORDER BY id DESC LIMIT 1`))[0];
  const ver = await j(await fetch(`${BASE}/api/auth/register/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code: otp.code }) }));
  const comp = await fetch(`${BASE}/api/auth/register/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, token: ver.token, password: PASSWORD }) });
  const cookie = (comp.headers.get('set-cookie') || '').split(';')[0];
  const me = await j(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } }));
  const csrf = me.csrfToken;
  const u = (await readDb(`SELECT id FROM users WHERE email='${EMAIL}'`))[0];
  const ws = (await readDb(`SELECT id FROM workspaces WHERE owner_user_id=${u.id}`))[0];
  console.log(`throwaway userId=${u.id} workspaceId=${ws.id} (free)`);

  const H = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf };
  const checks = [];
  const expect402 = async (label, res) => {
    const body = await j(res);
    const ok = res.status === 402 && body.error === 'upgrade_required';
    checks.push(ok);
    console.log(`  ${label}: ${res.status} ${ok ? '✅ 402 upgrade_required (feature=' + body.feature + ')' : '❌ ' + JSON.stringify(body)}`);
  };

  // a. first competitor allowed (0 < 1)
  const c1 = await fetch(`${BASE}/api/competitors`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'C1', url: 'https://c1.example.com' }) });
  console.log(`  add 1st competitor: ${c1.status} ${c1.status === 201 ? '✅ allowed (free includes 1)' : '⚠ ' + JSON.stringify(await j(c1))}`);
  // b. second competitor blocked
  await expect402('add 2nd competitor', await fetch(`${BASE}/api/competitors`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'C2', url: 'https://c2.example.com' }) }));
  // c. webhook URL (valid Slack format so only the gate can reject it)
  await expect402('set Slack webhook', await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ slack_webhook: 'https://gate-test.slack.com/webhook-format-check' }) }));
  // d. calendar connect (GET, session-auth internally)
  await expect402('connect Google Calendar', await fetch(`${BASE}/api/calendar/google/connect`, { headers: { Cookie: cookie }, redirect: 'manual' }));
  // e. playbook generation (requireFeature runs before ownership check)
  await expect402('generate playbook', await fetch(`${BASE}/api/playbooks/changes/1/generate`, { method: 'POST', headers: H }));
  // f. ROI / win-loss correlation
  await expect402('open ROI dashboard', await fetch(`${BASE}/api/roi`, { headers: { Cookie: cookie } }));

  // audit: gate_violation rows for this workspace
  const gv = await readDb(`SELECT event_data FROM audit_log WHERE event_type='gate_violation' AND workspace_id=${ws.id} ORDER BY id`);
  const feats = gv.map(r => { try { return JSON.parse(r.event_data).feature; } catch { return '?'; } });
  console.log(`  gate_violation audit rows: ${gv.length} → features: [${feats.join(', ')}]`);

  // persist throwaway for Test 11 (reuse same account: delete it there)
  fs.writeFileSync(path.join(__dirname, '.throwaway.json'), JSON.stringify({ email: EMAIL, password: PASSWORD, cookie, csrf, userId: u.id, workspaceId: ws.id }));

  const pass = checks.every(Boolean) && checks.length === 5 && gv.length >= 5;
  console.log(`\nTEST 5: ${pass ? 'PASS ✅ — all Pro features gated with 402 + gate_violation audited' : 'FAIL ❌'}`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
