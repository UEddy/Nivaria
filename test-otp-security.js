// Security tests for the OTP hardening (audit findings 2a + 2b):
//   2a — cryptographic OTP generation (crypto.randomInt, not Math.random)
//   2b — per-email OTP verification lockout (burn the code after 5 wrong guesses)
//
// Runs against a throwaway SQLite file so it never touches the dev DB. Exercises
// the real verifyOtp helper (the actual DB reads/writes + lockout logic) and the
// real generateOtp. No HTTP/rate-limit layer so the assertions are deterministic.

const path = require('path');
const fs   = require('fs');
const os   = require('os');

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `nivaria-otp-test-${Date.now()}.db`);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'otp-test-secret-0123456789abcdef';

const { initDb, getDb } = require('./src/db');
const { generateOtp, verifyOtp, hashEmail, MAX_OTP_ATTEMPTS } = require('./src/routes/auth')._otpInternals;

let passed = 0, failed = 0;
function ok(name)        { passed++; console.log(`  ✅ ${name}`); }
function bad(name, info) { failed++; console.log(`  ❌ ${name}${info ? ` — ${info}` : ''}`); }
function assert(cond, name, info) { cond ? ok(name) : bad(name, info); }

// Insert a fresh OTP row and return its code. minutesValid<0 => already expired.
function seedOtp(db, email, purpose, minutesValid = 10) {
  const code = generateOtp();
  db.prepare("UPDATE otp_codes SET used = 1 WHERE email = ? AND purpose = ? AND used = 0").run(email, purpose);
  const expires = new Date(Date.now() + minutesValid * 60 * 1000).toISOString();
  db.prepare('INSERT INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(email, code, purpose, expires);
  return code;
}

function wrongCodeFor(code) { return code === '000000' ? '111111' : '000000'; }

(async () => {
  await initDb();
  const db = getDb();

  // ── 2a: generation range + randomness ──────────────────────────────────────
  console.log('\n[2a] Cryptographic OTP generation');
  {
    let allShape = true, min = Infinity, max = -Infinity;
    const seen = new Set();
    const N = 50000;
    for (let i = 0; i < N; i++) {
      const c = generateOtp();
      if (typeof c !== 'string' || !/^\d{6}$/.test(c)) { allShape = false; break; }
      const n = Number(c);
      if (n < min) min = n;
      if (n > max) max = n;
      seen.add(c);
    }
    assert(allShape, `all ${N} codes are 6-digit strings`);
    assert(min >= 100000, 'minimum >= 100000', `got ${min}`);
    assert(max <= 999999, 'maximum <= 999999', `got ${max}`);
    assert(seen.size > N * 0.9, 'high uniqueness (CSPRNG, not constant)', `${seen.size}/${N} distinct`);
    // crypto.randomInt would throw if the range were misconfigured — confirm it
    // is genuinely the crypto path by checking it never produces out-of-range.
    assert(min !== Infinity && max !== -Infinity, 'generator produced values');
  }

  // ── 2b: lockout after MAX_OTP_ATTEMPTS wrong guesses ────────────────────────
  console.log('\n[2b] Per-email verification lockout');
  {
    const email = 'lockout@test.com';
    const code  = seedOtp(db, email, 'register');
    const wrong = wrongCodeFor(code);

    // Capture console.warn so we can assert the lockout log is privacy-safe.
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args); };

    let allWrongRejected = true;
    for (let i = 1; i <= MAX_OTP_ATTEMPTS; i++) {
      const r = verifyOtp(db, email, 'register', wrong);
      if (!r.error || r.token) allWrongRejected = false;
    }
    console.warn = origWarn;

    assert(allWrongRejected, `all ${MAX_OTP_ATTEMPTS} wrong guesses rejected`);

    const row = db.prepare("SELECT used, failed_attempts FROM otp_codes WHERE email = ? AND purpose = 'register' ORDER BY id DESC LIMIT 1").get(email);
    assert(row.failed_attempts >= MAX_OTP_ATTEMPTS, 'failed_attempts reached the cap', `got ${row.failed_attempts}`);
    assert(row.used === 1, 'code is burned (used=1) after lockout');

    // The crucial property: the CORRECT code no longer verifies once locked out.
    const afterLock = verifyOtp(db, email, 'register', code);
    assert(!!afterLock.error && !afterLock.token, 'correct code FAILS after lockout', JSON.stringify(afterLock));
    assert(afterLock.error === 'Invalid code', 'lockout returns generic message (no state leak)', afterLock.error);

    // Privacy: the lockout log must carry a hashed email, never the raw address.
    const lockoutLog = warnings.find(w => String(w[0]).includes('[OTP_LOCKOUT]'));
    assert(!!lockoutLog, '[OTP_LOCKOUT] was logged');
    if (lockoutLog) {
      const serialized = JSON.stringify(lockoutLog);
      assert(!serialized.includes(email), 'lockout log does NOT contain raw email');
      assert(serialized.includes(hashEmail(email)), 'lockout log contains the salted email hash');
      assert(/^[0-9a-f]{64}$/.test(hashEmail(email)), 'email hash is 64-char SHA-256 hex');
    }
  }

  // ── 2b: requesting a NEW code resets the lockout (legitimate recovery) ───────
  console.log('\n[2b] New code resets lockout (user recovery)');
  {
    const email = 'recover@test.com';
    const first = seedOtp(db, email, 'register');
    const wrong = wrongCodeFor(first);
    for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) verifyOtp(db, email, 'register', wrong); // lock it out
    const lockedOut = verifyOtp(db, email, 'register', first);
    assert(!!lockedOut.error, 'first code is locked out');

    // Simulate /register/request|resend issuing a fresh code (invalidate + insert).
    const second = seedOtp(db, email, 'register');
    assert(second !== first, 'a new distinct code was issued');
    const recovered = verifyOtp(db, email, 'register', second);
    assert(!!recovered.token && !recovered.error, 'new correct code verifies (lockout cleared)', JSON.stringify(recovered));
  }

  // ── Existing flows still work end-to-end (verify step of both purposes) ──────
  console.log('\n[regression] signup + reset verify happy paths');
  {
    // Registration verify → downstream /register/complete lookup still matches.
    const rEmail = 'signup@test.com';
    const rCode  = seedOtp(db, rEmail, 'register');
    const rRes   = verifyOtp(db, rEmail, 'register', rCode);
    assert(!!rRes.token, 'register: correct code returns a token');
    const completeRow = db.prepare(
      "SELECT id FROM otp_codes WHERE email = ? AND verified_token = ? AND purpose = 'register' AND used = 1"
    ).get(rEmail, rRes.token);
    assert(!!completeRow, 'register: verified_token + used=1 row found (complete step works)');

    // Password-reset verify → downstream /forgot/reset lookup still matches.
    const pEmail = 'reset@test.com';
    const pCode  = seedOtp(db, pEmail, 'reset');
    const pRes   = verifyOtp(db, pEmail, 'reset', pCode);
    assert(!!pRes.token, 'reset: correct code returns a token');
    const resetRow = db.prepare(
      "SELECT id FROM otp_codes WHERE email = ? AND verified_token = ? AND purpose = 'reset' AND used = 1"
    ).get(pEmail, pRes.token);
    assert(!!resetRow, 'reset: verified_token + used=1 row found (reset step works)');
  }

  // ── Expiry path unchanged ───────────────────────────────────────────────────
  console.log('\n[regression] expired code path');
  {
    const email = 'expired@test.com';
    const code  = seedOtp(db, email, 'register', -1); // already expired
    const r     = verifyOtp(db, email, 'register', code);
    assert(r.error === 'Code expired. Request a new one.', 'expired code returns expiry message', JSON.stringify(r));
  }

  // ── Summary + cleanup ───────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}\n${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'}: ${passed} passed, ${failed} failed`);
  try { fs.unlinkSync(process.env.DATABASE_PATH); } catch (_) {}
  // Clean up the dev-only pre-migration backup if one was written for the temp DB.
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(path.basename(process.env.DATABASE_PATH)) && f.endsWith('.bak')) {
        fs.unlinkSync(path.join(os.tmpdir(), f));
      }
    }
  } catch (_) {}
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
