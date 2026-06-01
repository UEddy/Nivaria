// Test 11 part A — account deletion request flow (server running).
// Wrong-password rejection, deletion request (30-day grace), email-link cancel
// (restore), then re-request so part B can simulate the 30-day cron.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const j = (r) => r.json().catch(() => ({}));
const tw = JSON.parse(fs.readFileSync(path.join(__dirname, '.throwaway.json'), 'utf8'));
function readUser() {
  return require('sql.js')().then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
    const r = db.exec(`SELECT deletion_requested_at, deletion_scheduled_at, deletion_cancel_token FROM users WHERE id=${tw.userId}`);
    return r[0] ? Object.fromEntries(r[0].values[0].map((x, i) => [r[0].columns[i], x])) : {};
  });
}
function auditCount(type) {
  return require('sql.js')().then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
    const r = db.exec(`SELECT COUNT(*) FROM audit_log WHERE event_type='${type}' AND user_id=${tw.userId}`);
    return r[0] ? Number(r[0].values[0][0]) : 0;
  });
}

(async () => {
  const H = { 'Content-Type': 'application/json', Cookie: tw.cookie, 'X-CSRF-Token': tw.csrf };
  const checks = [];

  // 1. Fresh-auth: wrong password must be rejected (session alone is not enough).
  const wrong = await fetch(`${BASE}/api/account/delete`, { method: 'POST', headers: H, body: JSON.stringify({ password: 'TotallyWrong!9' }) });
  console.log(`wrong password → ${wrong.status} ${wrong.status === 401 ? '✅ rejected' : '❌'}`); checks.push(wrong.status === 401);

  // 2. Correct password → schedule deletion.
  const del = await fetch(`${BASE}/api/account/delete`, { method: 'POST', headers: H, body: JSON.stringify({ password: tw.password }) });
  const delBody = await j(del);
  console.log(`delete request → ${del.status} ${JSON.stringify(delBody)}`); checks.push(del.status === 200 && !!delBody.scheduledAt);

  // 3. Fields populated?
  let u = await readUser();
  console.log(`deletion_requested_at=${u.deletion_requested_at} scheduled_at=${u.deletion_scheduled_at} token=${u.deletion_cancel_token ? 'set(' + String(u.deletion_cancel_token).length + ')' : 'NULL'}`);
  checks.push(!!u.deletion_requested_at && !!u.deletion_scheduled_at && !!u.deletion_cancel_token);
  const reqAudit = await auditCount('account_deletion_requested');
  console.log(`account_deletion_requested audit rows: ${reqAudit} ${reqAudit >= 1 ? '✅' : '❌'}`); checks.push(reqAudit >= 1);

  // 4. Email-link cancel (public token route) → restore.
  const token = u.deletion_cancel_token;
  const cancel = await fetch(`${BASE}/api/account/delete/cancel?token=${token}`, { redirect: 'manual' });
  const loc = cancel.headers.get('location') || '';
  console.log(`email-link cancel → ${cancel.status} location=${loc} ${(cancel.status === 302 && loc.includes('restore=ok')) ? '✅' : '❌'}`);
  checks.push(cancel.status === 302 && loc.includes('restore=ok'));
  u = await readUser();
  console.log(`after cancel: requested_at=${u.deletion_requested_at || 'NULL'} (expect NULL) ${!u.deletion_requested_at ? '✅ restored' : '❌'}`);
  checks.push(!u.deletion_requested_at);
  const cancelAudit = await auditCount('account_deletion_cancelled');
  console.log(`account_deletion_cancelled audit rows: ${cancelAudit} ${cancelAudit >= 1 ? '✅' : '❌'}`); checks.push(cancelAudit >= 1);

  // 5. Re-request deletion so Part B can run the 30-day cron.
  const del2 = await fetch(`${BASE}/api/account/delete`, { method: 'POST', headers: H, body: JSON.stringify({ password: tw.password }) });
  console.log(`re-request deletion → ${del2.status} ${del2.status === 200 ? '✅ (pending for Part B)' : '❌'}`); checks.push(del2.status === 200);

  console.log(`\nTEST 11 (Part A): ${checks.every(Boolean) ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
