require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const session = require('express-session');
const helmet  = require('helmet');
const path    = require('path');
const crypto  = require('crypto');

const { initDb, getDb }      = require('./db');
const { startScheduler }     = require('./scheduler');
const limits                 = require('./middleware/rateLimits');
const { csrfProtect, requestLogger, productionErrorHandler } = require('./middleware/security');

const authRouter        = require('./routes/auth');
const competitorsRouter = require('./routes/competitors');
const changesRouter     = require('./routes/changes');
const settingsRouter    = require('./routes/settings');
const userContextRouter = require('./routes/userContext');
const voiceProfileRouter = require('./routes/voiceProfile');
const playbooksRouter    = require('./routes/playbooks');
const calendarRouter    = require('./routes/calendar');
const dealsRouter        = require('./routes/deals');
const roiRouter          = require('./routes/roi');
const slackRouter        = require('./routes/slack');
// Phase 10 — billing, waitlist, GDPR account routes + webhook handler.
const billingRouter      = require('./routes/billing');
const waitlistRouter     = require('./routes/waitlist');
const accountRouter      = require('./routes/account');
const { handleLemonSqueezyWebhook } = require('./lemonSqueezyWebhook');
const { getUserCurrentWorkspace } = require('./lib/workspace');

// ── DB-backed session store ────────────────────────────────────────────────────

class SqlJsSessionStore extends session.Store {
  constructor() { super(); }

  get(sid, cb) {
    try {
      const row = getDb().prepare(
        "SELECT data FROM sessions WHERE sid = ? AND expires_at > datetime('now')"
      ).get(sid);
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires instanceof Date
        ? sess.cookie.expires.toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      getDb().prepare('INSERT OR REPLACE INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

const sessionStore = new SqlJsSessionStore();

// ── App ────────────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security headers (helmet) ──────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      // 'unsafe-inline' required for the anti-flash theme snippet in static HTML files.
      // A nonce-based CSP would remove this; tracked as a known limitation.
      scriptSrc:      ["'self'", "'unsafe-inline'"],
      // Helmet's default for script-src-attr is 'none', which blocks all inline
      // event handlers (onclick, oninput, etc.). The SPA uses inline handlers
      // throughout for view switching, OTP submit, password eye toggles, etc.
      // Refactoring to addEventListener is a planned hardening step.
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'"],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
    },
    // upgradeInsecureRequests in production only
    reportOnly: false,
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 63072000, // 2 years
    includeSubDomains: true,
    preload: true,
  },
}));

// ── Core middleware ────────────────────────────────────────────────────────────

app.use(cors({ origin: false }));

// ── Lemon Squeezy webhook (RAW body — MUST precede express.json) ────────────────
// The HMAC-SHA256 signature is verified against the exact raw bytes; parsing the
// JSON first would alter the body and break verification. No CSRF/session auth —
// authenticity is established solely by the signature.
app.post('/api/webhooks/lemonsqueezy', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const { statusCode, body } = handleLemonSqueezyWebhook(req.body, req.headers['x-signature'], req);
  res.status(statusCode).json(body);
});

app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);

app.use(session({
  name:             'cs.sid',
  secret:           process.env.SESSION_SECRET || 'cs-dev-secret-CHANGE-THIS-IN-PRODUCTION',
  resave:           false,
  saveUninitialized: false,
  store:            sessionStore,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    // 'lax' (not 'strict') so the session cookie is sent on top-level
    // cross-site navigations like Google's OAuth 302 back to
    // /api/calendar/google/callback. CSRF is still protected: csrfProtect
    // middleware enforces a double-submit token on every POST/PUT/DELETE,
    // and 'lax' continues to block cookies on cross-site POST/iframe loads.
    sameSite: 'lax',
    // No maxAge by default = session cookie (browser-close expiry).
    // Login route sets maxAge = 30 days when "Remember me" is checked.
  },
}));

// ── Guard /app ─────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.path === '/app' || req.path.startsWith('/app/')) {
    if (!req.session?.userId) {
      if (req.method === 'GET') {
        return res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
      }
      return res.redirect('/login');
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

// ── Auth middleware ────────────────────────────────────────────────────────────

// Phase 10 — resolve the user's current workspace onto the request so every
// protected route can scope/gate by workspace. Phase 10: always the user's own
// personal workspace (role 'owner'). Phase 10.5: session-based active workspace.
function attachWorkspace(req) {
  try {
    const ws = getUserCurrentWorkspace(req.userId);
    req.workspaceId   = ws ? ws.id : null;
    req.workspace     = ws || null;
    req.workspaceRole = ws ? 'owner' : null;
  } catch (_) {
    req.workspaceId = null; req.workspace = null; req.workspaceRole = null;
  }
}

function requireAuth(req, res, next) {
  const db = getDb();

  // API-key auth (programmatic access)
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const user = db.prepare('SELECT * FROM users WHERE api_key = ?').get(apiKey);
    if (!user) return res.status(401).json({ error: 'Invalid API key' });
    req.userId = user.id;
    req.user   = user;
    attachWorkspace(req);
    return next();
  }

  // Session auth
  if (req.session?.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    // Reject sessions that predate a password change
    if (req.session.sessionVersion !== undefined &&
        req.session.sessionVersion !== user.session_version) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    // Ensure every authenticated session has a CSRF token
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session.save(() => {}); // async, fire-and-forget
    }

    req.userId = user.id;
    req.user   = user;
    attachWorkspace(req);
    return next();
  }

  return res.status(401).json({ error: 'Not authenticated' });
}

// ── Rate-limited API routes ────────────────────────────────────────────────────

// Auth endpoints: individual limits applied per-route in auth.js
app.use('/api/auth', authRouter);

// Protected endpoints: general rate limit + auth + CSRF
app.use('/api/competitors',  limits.api, requireAuth, csrfProtect, competitorsRouter);
app.use('/api/changes',      limits.api, requireAuth, csrfProtect, changesRouter);
app.use('/api/settings',     limits.api, requireAuth, csrfProtect, settingsRouter);
app.use('/api/user/context',       limits.api, requireAuth, csrfProtect, userContextRouter);
app.use('/api/user/voice-profile', limits.api, requireAuth, csrfProtect, voiceProfileRouter);
app.use('/api/playbooks',          limits.api, requireAuth, csrfProtect, playbooksRouter);

// Phase 9 — win/loss deals + ROI dashboard. Standard protected mounting.
app.use('/api/deals', limits.api, requireAuth, csrfProtect, dealsRouter);
app.use('/api/roi',   limits.api, requireAuth, csrfProtect, roiRouter);

// Phase 10 — billing + GDPR account routes (protected). Per-endpoint rate
// limits live inside the routers. The public email-link restore is registered
// BEFORE the protected /api/account mount so the unauthenticated GET resolves
// first (the in-app POST /delete/cancel still routes to the protected router).
app.get('/api/account/delete/cancel', accountRouter.restoreByToken);
app.use('/api/billing', limits.api, requireAuth, csrfProtect, billingRouter);
app.use('/api/account', limits.api, requireAuth, csrfProtect, accountRouter);

// Phase 10 — Team/Business waitlist (PUBLIC, IP rate-limited).
app.use('/api/waitlist', limits.waitlist, waitlistRouter);

// Phase 9 — Slack. The router does its own auth internally: the slash command
// + interactions endpoints are authenticated by Slack's request signature (not
// a session) and need the raw body, so they cannot use requireAuth+csrfProtect.
// The OAuth start/callback/disconnect routes enforce session auth themselves.
app.use('/api/slack', limits.slack, slackRouter);

// Phase 7 — calendar router does its own auth + CSRF internally because OAuth
// callback + the navigational /connect redirect cannot use the standard
// requireAuth+csrfProtect mounting (callback has no session-cookie path tied
// to the API CSRF token, and the redirect is a top-level GET).
app.use('/api/calendar', limits.api, calendarRouter);

// Stripe webhook (raw body, no CSRF needed — validated by Stripe signature)
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const { handleStripeWebhook } = require('./payments');
    await handleStripeWebhook(req.body, req.headers['stripe-signature']);
    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ── Auth pages ─────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/app');
  res.sendFile(path.join(__dirname, '../public/auth/index.html'));
});

app.get('/register', (req, res) => {
  if (req.session?.userId) return res.redirect('/app');
  res.sendFile(path.join(__dirname, '../public/auth/index.html'));
});

// ── Dashboard SPA ──────────────────────────────────────────────────────────────

app.get('/app',   (req, res) => res.sendFile(path.join(__dirname, '../public/app/index.html')));
app.get('/app/*', (req, res) => res.sendFile(path.join(__dirname, '../public/app/index.html')));

// Landing page fallback
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Production error handler ───────────────────────────────────────────────────

app.use(productionErrorHandler);

// ── Start ──────────────────────────────────────────────────────────────────────

function logAnthropicKeyStatus() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.warn('⚠️  ANTHROPIC_API_KEY is not set — change analysis will use rule-based fallback');
    return;
  }
  const prefix = key.slice(0, 10);
  const shapeOk = /^sk-ant-[a-z0-9-]+/i.test(key) && key.length > 30;
  if (shapeOk) {
    console.log(`✅ ANTHROPIC_API_KEY present (prefix: ${prefix}…, length: ${key.length}) — AI analysis enabled`);
  } else {
    console.warn(`⚠️  ANTHROPIC_API_KEY is set (prefix: ${prefix}…, length: ${key.length}) but shape looks unusual — AI calls may fail`);
  }
}

initDb().then(() => {
  // Purge expired sessions hourly
  setInterval(() => {
    try { getDb().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run(); } catch (_) {}
  }, 60 * 60 * 1000);

  logAnthropicKeyStatus();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`\n🔍 Foresight — http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
