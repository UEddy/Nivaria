const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { v4: uuidv4 }  = require('uuid');
const bcrypt          = require('bcryptjs');
const { getDb }       = require('../db');
const { sendOtpEmail} = require('../email');
const limits          = require('../middleware/rateLimits');
const { csrfProtect } = require('../middleware/security');
const { createPersonalWorkspace } = require('../lib/workspace');

// ── Common weak passwords ──────────────────────────────────────────────────────

const COMMON_PASSWORDS = new Set([
  'password','password1','password12','password123','password1234','password12345',
  '123456','12345','1234','12345678','123456789','1234567890',
  'qwerty','qwerty123','qwertyuiop','qwerty12','qwerty12345',
  'abc123','abc1234','abc12345','abcd1234','abcdef123',
  'iloveyou','iloveyou1','iloveyou2',
  'admin','admin1','admin12','admin123','admin1234','adminadmin',
  'letmein','letmein1','letmein12','letmein123',
  'welcome','welcome1','welcome123',
  'monkey','monkey1','monkey123',
  'dragon','dragon1','dragon123',
  'master','master1','master123',
  'sunshine','princess','football','baseball','soccer','hockey',
  'batman','superman','shadow','shadow1','trustno1','mustang','access',
  'hello','hello123','login','login123',
  'pass','passw0rd','p@ssword','p@ssw0rd','password!',
  'changeme','changeme1','test123','test1234',
  '111111','000000','696969','123123','654321','112233',
  '1q2w3e4r','1q2w3e4r5t','1qaz2wsx','zxcvbnm','asdfghjkl',
  'michael','jessica','charlie','donald','thomas','andrew','jordan',
  'summer2023','winter2023','spring2023','fall2023',
  'summer2024','winter2024','spring2024',
  'summer2025','winter2025','spring2025',
  'p@ssw0rd','passw0rd1','P@ssw0rd','Passw0rd','Password1','Password123','Password1!',
]);

// ── Input helpers ──────────────────────────────────────────────────────────────

function sanitizeEmail(raw) {
  return String(raw || '').toLowerCase().trim().slice(0, 254);
}

function isValidEmail(email) {
  return email.length >= 5 && email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Returns null if valid, otherwise an error string
function validatePassword(pw, email) {
  if (typeof pw !== 'string' || !pw) return 'Password is required';
  if (pw.length < 12)  return 'Password must be at least 12 characters';
  if (pw.length > 128) return 'Password must be at most 128 characters';
  if (!/[A-Z]/.test(pw)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(pw)) return 'Password must contain at least one lowercase letter';
  if (!/\d/.test(pw))    return 'Password must contain at least one number';
  if (!/[!@#$%^&*()\-_+=[\]{}|;:,.<>?]/.test(pw))
    return 'Password must contain at least one special character (!@#$%^&*()_+-=[]{}|;:,.<>?)';
  if (email) {
    const pwLower  = pw.toLowerCase();
    const eml      = email.toLowerCase();
    const local    = eml.split('@')[0];
    if (pwLower.includes(eml) || (local.length >= 4 && pwLower.includes(local)))
      return 'Password cannot contain your email address';
  }
  if (COMMON_PASSWORDS.has(pw.toLowerCase()))
    return 'Password is too common. Please choose a more unique password';
  return null;
}

// Friendly display name ("What should we call you?"). Returns null when valid,
// else an error string. Allows letters (incl. accented), spaces, and the few
// name punctuation marks (. ' -); rejects digits and any character that could
// act as an XSS vector (< > & " / …). Output is still HTML-escaped at render.
const FIRST_NAME_RE = /^[\p{L}\p{M} .'\-]{1,50}$/u;
function validateFirstName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) return 'Please tell us what to call you';
  if (name.length > 50) return 'Name must be 50 characters or fewer';
  if (!FIRST_NAME_RE.test(name)) return 'Name can only contain letters, spaces, hyphens, apostrophes, and periods';
  return null;
}

// Normalize a client-supplied IANA timezone. Verified against the host's
// timezone database via Intl; anything unknown/garbage falls back to 'UTC'.
function sanitizeTimezone(raw) {
  const tz = String(raw == null ? '' : raw).trim();
  if (!tz || tz.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }); // throws on invalid zone
    return tz;
  } catch { return 'UTC'; }
}

// Cryptographically secure 6-digit code (100000-999999). crypto.randomInt is
// unbiased over the half-open range and pulls from the CSPRNG, unlike
// Math.random() whose internal state is recoverable from observed outputs.
function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

// ── Per-email OTP verification lockout ─────────────────────────────────────────
// Mirrors the per-email login_attempts cap: after MAX_OTP_ATTEMPTS wrong guesses
// against a single active code we burn it (used=1) so even the correct value no
// longer verifies. The per-IP otp rate limit guards request volume; this guards
// a single targeted code against IP-rotating brute force of the 10^6 space.

const MAX_OTP_ATTEMPTS = 5;

// Privacy-preserving email hash for lockout logs — never log the raw address.
// Same salted-SHA-256 construction as lib/audit.hashIp.
function hashEmail(email) {
  const salt = process.env.SESSION_SECRET || 'cs-audit-salt';
  return crypto.createHash('sha256').update(String(email) + salt).digest('hex');
}

// Verify a submitted OTP for (email, purpose) against the single active (unused,
// unexpired) code. register/request, register/resend and forgot/request each
// invalidate any prior unused code before issuing a new one, so there is exactly
// one active code per (email, purpose) at a time — "latest unused" is that code.
// Tracks failed attempts on it and locks out after MAX_OTP_ATTEMPTS. Lockout is
// indistinguishable from a normal wrong code (same generic message), so it never
// reveals account state. Requesting a new code clears the lockout (fresh row,
// failed_attempts=0). Returns { token } on success, or { status, error }.
function verifyOtp(db, email, purpose, code) {
  const active = db.prepare(
    "SELECT * FROM otp_codes WHERE email = ? AND purpose = ? AND used = 0 ORDER BY id DESC LIMIT 1"
  ).get(email, purpose);

  if (!active)                                    return { status: 400, error: 'Invalid code' };
  if (new Date(active.expires_at) < new Date())   return { status: 400, error: 'Code expired. Request a new one.' };

  if (active.code !== code) {
    const failed = (active.failed_attempts || 0) + 1;
    if (failed >= MAX_OTP_ATTEMPTS) {
      db.prepare('UPDATE otp_codes SET used = 1, failed_attempts = ? WHERE id = ?').run(failed, active.id);
      console.warn('[OTP_LOCKOUT]', { email: hashEmail(email), purpose, attempts: failed });
    } else {
      db.prepare('UPDATE otp_codes SET failed_attempts = ? WHERE id = ?').run(failed, active.id);
    }
    return { status: 400, error: 'Invalid code' };
  }

  const verifiedToken = uuidv4();
  db.prepare('UPDATE otp_codes SET used = 1, verified_token = ? WHERE id = ?').run(verifiedToken, active.id);
  return { token: verifiedToken };
}

// ── Rate limiting ──────────────────────────────────────────────────────────────
// Per-email login rate limiting (complements the per-IP limit in middleware)

function isRateLimited(db, email) {
  const { n } = db.prepare(
    "SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND attempted_at > datetime('now', '-15 minutes')"
  ).get(email);
  return n >= 5;
}

function recordAttempt(db, email) {
  db.prepare('INSERT INTO login_attempts (email) VALUES (?)').run(email);
}

// ── Registration — Step 1: send OTP ───────────────────────────────────────────

router.post('/register/request', limits.register, async (req, res) => {
  const email = sanitizeEmail(req.body.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT email_verified FROM users WHERE email = ?').get(email);
  if (existing?.email_verified) {
    return res.status(400).json({ error: 'An account already exists with this email. Please log in.' });
  }

  const activeOtp = db.prepare(
    "SELECT code FROM otp_codes WHERE email = ? AND purpose = 'register' AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1"
  ).get(email);

  const code = activeOtp ? activeOtp.code : generateOtp();

  if (!activeOtp) {
    db.prepare("UPDATE otp_codes SET used = 1 WHERE email = ? AND purpose = 'register' AND used = 0").run(email);
    db.prepare('INSERT INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)').run(
      email, code, 'register', new Date(Date.now() + 10 * 60 * 1000).toISOString()
    );
  }

  try {
    await sendOtpEmail(email, code, 'register');
    res.json({ sent: true });
  } catch (err) {
    console.error('OTP email error:', err.message);
    res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
  }
});

// ── Registration — Resend OTP ─────────────────────────────────────────────────
// Explicit "Resend code" action from the verification page. Unlike
// /register/request (which reuses a still-valid code so an accidental double
// submit doesn't churn the OTP), a resend is a deliberate user action — usually
// because the previous code expired — so we ALWAYS invalidate any outstanding
// code and issue a fresh one.

router.post('/register/resend', limits.register, async (req, res) => {
  const email = sanitizeEmail(req.body.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const db = getDb();

  // Already verified — nothing to resend; the user should just log in.
  const existing = db.prepare('SELECT email_verified FROM users WHERE email = ?').get(email);
  if (existing?.email_verified) {
    return res.status(400).json({ error: 'An account already exists with this email. Please log in.' });
  }

  // Pending-verification state is represented by a prior 'register' OTP for this
  // email (no users row exists until /register/complete). Requiring one stops
  // this endpoint from being used to blast codes at addresses that never began
  // signup.
  const priorOtp = db.prepare(
    "SELECT id FROM otp_codes WHERE email = ? AND purpose = 'register' ORDER BY id DESC LIMIT 1"
  ).get(email);
  if (!priorOtp) {
    return res.status(400).json({ error: 'No pending verification for this email. Please start signup again.' });
  }

  // Invalidate every outstanding code, then issue a fresh one.
  const code = generateOtp();
  db.prepare("UPDATE otp_codes SET used = 1 WHERE email = ? AND purpose = 'register' AND used = 0").run(email);
  db.prepare('INSERT INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)').run(
    email, code, 'register', new Date(Date.now() + 10 * 60 * 1000).toISOString()
  );

  // sendOtpEmail never throws on a delivery failure (it logs the error under
  // [EMAIL_DELIVERY_FAILED] and degrades gracefully); guard anyway so an
  // unexpected throw can't 500.
  try {
    await sendOtpEmail(email, code, 'register');
  } catch (err) {
    console.error('OTP resend email error:', err.message);
  }
  res.json({ sent: true });
});

// ── Registration — Step 2: verify OTP ─────────────────────────────────────────

router.post('/register/verify', limits.otp, (req, res) => {
  const email = sanitizeEmail(req.body.email);
  const code  = String(req.body.code || '').trim().slice(0, 6);

  if (!email || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Valid email and 6-digit code are required' });
  }

  const result = verifyOtp(getDb(), email, 'register', code);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ verified: true, token: result.token });
});

// ── Registration — Step 3: set password + create account ──────────────────────

router.post('/register/complete', async (req, res) => {
  const email    = sanitizeEmail(req.body.email);
  const token    = String(req.body.token   || '').trim();
  const password = String(req.body.password || '');

  if (!email || !token || !password) return res.status(400).json({ error: 'Missing required fields' });

  // Required friendly name + browser timezone captured on the password step.
  const nameError = validateFirstName(req.body.firstName);
  if (nameError) return res.status(400).json({ error: nameError });
  const firstName = String(req.body.firstName).trim();
  const timezone  = sanitizeTimezone(req.body.timezone);

  const pwError = validatePassword(password, email);
  if (pwError) return res.status(400).json({ error: pwError });

  const db  = getDb();
  const otp = db.prepare(
    "SELECT * FROM otp_codes WHERE email = ? AND verified_token = ? AND purpose = 'register' AND used = 1"
  ).get(email, token);

  if (!otp)                                  return res.status(400).json({ error: 'Invalid session. Please start over.' });
  if (new Date(otp.expires_at) < new Date()) return res.status(400).json({ error: 'Session expired. Please start over.' });

  const passwordHash = await bcrypt.hash(password, 12);
  const apiKey       = 'cs-' + uuidv4().replace(/-/g, '');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  let userId;

  if (existing) {
    // Re-completing a pending signup — capture the name/timezone too (the row may
    // predate them) so the greeting and profile are populated from the start.
    db.prepare('UPDATE users SET password_hash = ?, email_verified = 1, first_name = ?, name = ?, timezone = ? WHERE id = ?')
      .run(passwordHash, firstName, firstName, timezone, existing.id);
    userId = existing.id;
  } else {
    const r = db.prepare(
      'INSERT INTO users (email, name, first_name, timezone, tier, api_key, password_hash, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(email, firstName, firstName, timezone, 'free', apiKey, passwordHash, 1);
    userId = r.lastInsertRowid;
    db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(userId);
  }

  // Phase 10: every account owns a personal workspace. The startup migration
  // only backfills users that exist at boot, so new signups must bootstrap their
  // own workspace here or they'd be workspace-less until a restart. Idempotent.
  createPersonalWorkspace(userId, firstName, email);

  db.prepare('UPDATE otp_codes SET verified_token = NULL WHERE id = ?').run(otp.id);

  const freshUser = db.prepare('SELECT session_version FROM users WHERE id = ?').get(userId);

  // Regenerate session ID to prevent session fixation
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId         = userId;
    req.session.sessionVersion = freshUser?.session_version ?? 1;
    req.session.csrfToken      = crypto.randomBytes(32).toString('hex');
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: 'Session error' });
      const user = db.prepare('SELECT id, email, name, tier, api_key FROM users WHERE id = ?').get(userId);
      res.json({ success: true, user });
    });
  });
});

// ── Login ──────────────────────────────────────────────────────────────────────

router.post('/login', limits.login, async (req, res) => {
  const email      = sanitizeEmail(req.body.email);
  const password   = String(req.body.password   || '');
  const rememberMe = !!req.body.rememberMe;

  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  // Enforce maximum password length before bcrypt to prevent DoS
  if (password.length > 128) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const db = getDb();

  if (isRateLimited(db, email)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND email_verified = 1').get(email);

  // Always run bcrypt to prevent timing-based user enumeration
  const hashToTest = user?.password_hash || '$2a$12$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const match      = await bcrypt.compare(password, hashToTest);

  if (!user || !match) {
    recordAttempt(db, email);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  // Regenerate session ID to prevent session fixation
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    if (rememberMe) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
    req.session.userId         = user.id;
    req.session.sessionVersion = user.session_version;
    req.session.csrfToken      = crypto.randomBytes(32).toString('hex');
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: 'Session error' });
      res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, tier: user.tier } });
    });
  });
});

// ── Logout ─────────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Could not log out' });
    res.clearCookie('cs.sid');
    res.json({ success: true });
  });
});

// ── Current user ───────────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db   = getDb();
  const user = db.prepare('SELECT id, email, name, first_name, timezone, has_visited_dashboard, tier, api_key, created_at FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  // Return CSRF token so the SPA can attach it to all mutation requests.
  // Generate one now if the session predates this feature.
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.save(() => {});
  }

  res.json({ ...user, csrfToken: req.session.csrfToken });
});

// ── Forgot password — Step 1: request OTP ─────────────────────────────────────

router.post('/forgot/request', limits.reset, async (req, res) => {
  const email = sanitizeEmail(req.body.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address' });

  const db   = getDb();
  const user = db.prepare('SELECT id FROM users WHERE email = ? AND email_verified = 1').get(email);

  if (user) {
    const existingReset = db.prepare(
      "SELECT code FROM otp_codes WHERE email = ? AND purpose = 'reset' AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1"
    ).get(email);

    const code = existingReset ? existingReset.code : generateOtp();

    if (!existingReset) {
      db.prepare("UPDATE otp_codes SET used = 1 WHERE email = ? AND purpose = 'reset' AND used = 0").run(email);
      db.prepare('INSERT INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)').run(
        email, code, 'reset', new Date(Date.now() + 10 * 60 * 1000).toISOString()
      );
    }

    try { await sendOtpEmail(email, code, 'reset'); } catch (err) { console.error('Reset email error:', err.message); }
  }

  // Always respond the same way to prevent user enumeration
  res.json({ sent: true });
});

// ── Forgot password — Step 2: verify OTP ──────────────────────────────────────

router.post('/forgot/verify', limits.otp, (req, res) => {
  const email = sanitizeEmail(req.body.email);
  const code  = String(req.body.code || '').trim().slice(0, 6);

  if (!email || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Valid email and 6-digit code are required' });
  }

  const result = verifyOtp(getDb(), email, 'reset', code);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ verified: true, token: result.token });
});

// ── Forgot password — Step 3: set new password ────────────────────────────────

router.post('/forgot/reset', async (req, res) => {
  const email    = sanitizeEmail(req.body.email);
  const token    = String(req.body.token    || '').trim();
  const password = String(req.body.password || '');

  const pwError = validatePassword(password, email);
  if (pwError) return res.status(400).json({ error: pwError });

  const db  = getDb();
  const otp = db.prepare(
    "SELECT * FROM otp_codes WHERE email = ? AND verified_token = ? AND purpose = 'reset' AND used = 1"
  ).get(email, token);

  if (!otp)                                  return res.status(400).json({ error: 'Invalid session. Please start over.' });
  if (new Date(otp.expires_at) < new Date()) return res.status(400).json({ error: 'Session expired. Please start over.' });

  const passwordHash = await bcrypt.hash(password, 12);

  // Increment session_version to invalidate all existing sessions
  db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE email = ?').run(passwordHash, email);
  db.prepare('UPDATE otp_codes SET verified_token = NULL WHERE id = ?').run(otp.id);

  res.json({ success: true });
});

// ── Tier switch (demo) — CSRF-protected ───────────────────────────────────────
// DEPRECATED (Phase 10): gating is now workspace-driven (workspaces.subscription_tier),
// so writing users.tier here no longer affects feature access. This demo control
// is superseded by the real billing UI (Phase 10 frontend) and is slated for
// removal in a post-launch cleanup. Left in place for now = zero behavior change.

router.put('/me/tier', csrfProtect, (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db   = getDb();
  const tier = String(req.body.tier || '');
  if (!['free', 'pro', 'team'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
  db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, req.session.userId);
  res.json({ success: true, tier });
});

// Test seam — internal OTP helpers exposed for the security unit tests in
// test-otp-security.js. Not referenced by any application code path.
router._otpInternals = { generateOtp, verifyOtp, hashEmail, MAX_OTP_ATTEMPTS };

module.exports = router;
