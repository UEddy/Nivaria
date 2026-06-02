// Test 10 — GDPR data export (Pro user = demo). Verifies sections present,
// password excluded, OAuth tokens MASKED, valid human-readable JSON, download
// header, and data_export_requested audit.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';

function auditCount() {
  return require('sql.js')().then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
    const r = db.exec("SELECT COUNT(*) FROM audit_log WHERE event_type='data_export_requested' AND user_id=1");
    return r[0] ? Number(r[0].values[0][0]) : 0;
  });
}

(async () => {
  const checks = [];
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@competitor-shadow.com', password: 'Demo1234!' }) });
  if (login.status === 429) { console.log('⚠ login rate-limited'); process.exit(1); }
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const auditBefore = await auditCount();

  const res = await fetch(`${BASE}/api/account/export`, { headers: { Cookie: cookie } });
  const cd = res.headers.get('content-disposition') || '';
  const raw = await res.text();
  console.log('status:', res.status, '| Content-Disposition:', cd);
  checks.push(res.status === 200 && /attachment; filename="nivaria-data-export-1-\d+\.json"/.test(cd));

  const data = JSON.parse(raw);
  const sections = ['export_metadata', 'user', 'workspaces', 'workspace_members', 'competitors', 'changes', 'generated_playbooks', 'deals', 'tracked_meetings', 'calendar_connections', 'slack_installations', 'correlations', 'pattern_alerts', 'user_context', 'user_voice_profile', 'settings', 'audit_log'];
  const missing = sections.filter(s => !(s in data));
  console.log('sections present:', missing.length === 0 ? 'ALL ✅' : 'MISSING ' + missing.join(','));
  checks.push(missing.length === 0);

  // password never exported
  const noPw = data.user && !('password_hash' in data.user) && !('api_key' in data.user);
  console.log('user record excludes password_hash/api_key:', noPw ? '✅' : '❌');
  checks.push(noPw);

  // calendar tokens masked
  const cal = (data.calendar_connections || [])[0];
  const calMasked = cal && cal.encrypted_access_token_present === true && !('access_token_enc' in cal) && !('refresh_token_enc' in cal);
  console.log('calendar token masked:', calMasked ? '✅ (encrypted_access_token_present=true, raw enc absent)' : '❌ ' + JSON.stringify(cal));
  checks.push(calMasked);

  // slack token masked
  const sl = (data.slack_installations || [])[0];
  const slMasked = sl && sl.encrypted_bot_token_present === true && !('bot_token_enc' in sl);
  console.log('slack token masked:', slMasked ? '✅ (encrypted_bot_token_present=true, raw enc absent)' : '❌ ' + JSON.stringify(sl));
  checks.push(slMasked);

  // human-readable (indented) JSON
  const indented = raw.includes('\n  ');
  console.log('human-readable (indented) JSON:', indented ? '✅' : '❌');
  checks.push(indented);

  // data sizes
  console.log(`payload: competitors=${(data.competitors || []).length} deals=${(data.deals || []).length} changes=${(data.changes || []).length} playbooks=${(data.generated_playbooks || []).length}`);

  const auditAfter = await auditCount();
  console.log(`data_export_requested audit: ${auditBefore} → ${auditAfter} (expect +1)`);
  checks.push(auditAfter === auditBefore + 1);

  console.log(`\nTEST 10: ${checks.every(Boolean) ? 'PASS ✅' : 'FAIL ❌ ' + JSON.stringify(checks)}`);
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
