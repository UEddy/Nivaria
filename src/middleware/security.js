// ── CSRF protection ────────────────────────────────────────────────────────────
// Double-submit: CSRF token stored in session, sent as X-CSRF-Token header.
// GET/HEAD/OPTIONS are idempotent — no token required.
// Auth endpoints (login, register, forgot) are exempt because they run before
// a session exists; sameSite=strict + cors(origin:false) protect them instead.

function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const sessionToken = req.session?.csrfToken;
  const headerToken  = req.headers['x-csrf-token'];

  if (!sessionToken || !headerToken || sessionToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid request token. Please refresh the page and try again.' });
  }
  next();
}

// ── Request logger ─────────────────────────────────────────────────────────────
// Logs IP, method, path, and status. Never logs request body or headers.

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ip = req.ip || req.socket?.remoteAddress || '-';
    // Mask all but the last octet for privacy
    const maskedIp = ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1***')
                       .replace(/([\da-f:]+:[\da-f:]+:)[\da-f:]+$/i, '$1***');
    if (res.statusCode >= 400) {
      console.warn(`${req.method} ${req.path} ${res.statusCode} ${ms}ms [${maskedIp}]`);
    }
  });
  next();
}

// ── Production error handler ───────────────────────────────────────────────────
// Must be registered as the last app.use() with four arguments.

function productionErrorHandler(err, req, res, _next) {
  const isProduction = process.env.NODE_ENV === 'production';
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  res.status(err.status || 500).json({
    error: isProduction
      ? 'Something went wrong. Please try again.'
      : err.message,
  });
}

module.exports = { csrfProtect, requestLogger, productionErrorHandler };
