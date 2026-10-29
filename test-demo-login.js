// The judge demo login (src/lib/demoAccount.js), end to end on a real server.
//
//   node test-demo-login.js
//
// Boots src/server.js on a throwaway database with DEMO_LOGIN_EMAIL and
// DEMO_LOGIN_PASSWORD set, then checks: password sign-in works with no OTP,
// the account cannot be deleted, renamed or password-reset, and changing the
// password in the environment takes effect at the next boot.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-login-'));
const PORT = 3000 + Math.floor(Math.random() * 2000) + 4000;
const B = 'http://localhost:' + PORT;
const EMAIL = 'judge@example.test';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  ok   ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

function boot(password) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: path.join(tmp, 'test.db'), DEMO_LOGIN_EMAIL: EMAIL, DEMO_LOGIN_PASSWORD: password, TASTE_EXAMPLES: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  return new Promise((resolve, reject) => {
    const until = Date.now() + 30000;
    const poll = async () => {
      try { if ((await fetch(B + '/health')).ok) return resolve({ child, log: () => log }); } catch (_) {}
      if (Date.now() > until) { child.kill(); return reject(new Error('server did not start:\n' + log)); }
      setTimeout(poll, 300);
    };
    poll();
  });
}

function stop(child) {
  return new Promise(resolve => { child.on('exit', resolve); child.kill(); });
}

async function login(password) {
  const res = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password }),
  });
  return { status: res.status, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function call(cookie, csrf, method, url, body) {
  const res = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  const first = await boot('first-password-123');
  check('boot log reports the demo login', /Demo login created for judge@example\.test/.test(first.log()), first.log().slice(-400));

  const ok = await login('first-password-123');
  check('signs in with email and password, no OTP', ok.status === 200 && Boolean(ok.cookie), String(ok.status));
  const me = await call(ok.cookie, null, 'GET', '/api/auth/me');
  check('the session is a verified account with a workspace', me.status === 200 && me.json.email === EMAIL);
  const csrf = me.json.csrfToken;
  const tasteStatus = await call(ok.cookie, null, 'GET', '/api/taste/runs');
  check('it can reach the Taste Gap API', tasteStatus.status === 200);

  const del = await call(ok.cookie, csrf, 'POST', '/api/account/delete', { password: 'first-password-123', confirmEmail: EMAIL });
  check('it cannot be deleted', del.status === 403, JSON.stringify(del.json));
  const rename = await call(ok.cookie, csrf, 'PUT', '/api/account/profile', { firstName: 'Hacked' });
  check('it cannot be renamed', rename.status === 403, JSON.stringify(rename.json));
  const tz = await call(ok.cookie, csrf, 'PUT', '/api/account/profile', { timezone: 'Africa/Lagos' });
  check('a timezone update still works', tz.status === 200, JSON.stringify(tz.json));
  const forgot = await call('', null, 'POST', '/api/auth/forgot/request', { email: EMAIL });
  check('a reset request gets the generic answer', forgot.status === 200, JSON.stringify(forgot.json));
  const reset = await call('', null, 'POST', '/api/auth/forgot/reset', { email: EMAIL, token: 'x', password: 'Another-password-456' });
  check('a password reset is refused', reset.status === 403, JSON.stringify(reset.json));
  await stop(first.child);

  const second = await boot('second-password-456');
  check('a changed password is applied at boot', /Demo login ready for judge@example\.test/.test(second.log()));
  check('the old password stops working', (await login('first-password-123')).status === 401);
  check('the new password works', (await login('second-password-456')).status === 200);
  await stop(second.child);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
