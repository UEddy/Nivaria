// Smoke test: registration now bootstraps a personal workspace immediately.
// Uses register/complete's own session cookie (avoids the login rate limiter).
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const EMAIL = `qa-throwaway-${Date.now()}@foresight.test`;
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
  console.log('throwaway email:', EMAIL);
  // 1. request OTP
  const req1 = await fetch(`${BASE}/api/auth/register/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) });
  console.log('register/request →', req1.status);
  // 2. read OTP from DB (read-only)
  const otp = (await readDb(`SELECT code FROM otp_codes WHERE email='${EMAIL}' AND purpose='register' AND used=0 ORDER BY id DESC LIMIT 1`))[0];
  console.log('OTP code present:', !!otp);
  // 3. verify
  const ver = await j(await fetch(`${BASE}/api/auth/register/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code: otp.code }) }));
  console.log('register/verify token:', ver.token ? 'received' : 'MISSING');
  // 4. complete (capture session cookie)
  const compRes = await fetch(`${BASE}/api/auth/register/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, token: ver.token, password: PASSWORD }) });
  const cookie = (compRes.headers.get('set-cookie') || '').split(';')[0];
  console.log('register/complete →', compRes.status);

  // 5. workspace + membership rows created?
  const u = (await readDb(`SELECT id FROM users WHERE email='${EMAIL}'`))[0];
  const ws = (await readDb(`SELECT id, owner_user_id, subscription_tier FROM workspaces WHERE owner_user_id=${u.id}`))[0];
  const mem = (await readDb(`SELECT role FROM workspace_members WHERE user_id=${u.id} AND workspace_id=${ws ? ws.id : 0}`))[0];
  console.log('user id:', u.id);
  console.log('workspace row:', JSON.stringify(ws) || 'NONE');
  console.log('membership row:', JSON.stringify(mem) || 'NONE');

  // 6. req.workspaceId populated on next authed request (no restart)?
  const sub = await j(await fetch(`${BASE}/api/billing/subscription`, { headers: { Cookie: cookie } }));
  console.log('GET /api/billing/subscription →', JSON.stringify(sub));

  const pass = ws && ws.subscription_tier === 'free' && mem && mem.role === 'owner' && sub && sub.effectiveTier === 'free' && sub.hasSubscription === false;
  console.log(`\nSMOKE: ${pass ? 'PASS ✅ — new signup gets a Free workspace + owner membership immediately, billing endpoint works (no restart)' : 'FAIL ❌'}`);
  // expose the throwaway creds for the rest of the matrix
  if (pass) console.log(`THROWAWAY_READY email=${EMAIL} password=${PASSWORD} userId=${u.id} workspaceId=${ws.id}`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
