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
    sameSite: 'strict',
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

function requireAuth(req, res, next) {
  const db = getDb();

  // API-key auth (programmatic access)
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const user = db.prepare('SELECT * FROM users WHERE api_key = ?').get(apiKey);
    if (!user) return res.status(401).json({ error: 'Invalid API key' });
    req.userId = user.id;
    req.user   = user;
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
app.use('/api/user/context', limits.api, requireAuth, csrfProtect, userContextRouter);

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
