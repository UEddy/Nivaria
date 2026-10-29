const rateLimit = require('express-rate-limit');
// IPv6-safe IP normalizer — used in the per-user limiter's IP fallback so an
// IPv6 client can't bypass limits by varying the low-order address bits.
const { ipKeyGenerator } = require('express-rate-limit');

function makeLimiter(windowMs, max, windowMinutes) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: `Too many requests. Try again in ${windowMinutes} minute${windowMinutes === 1 ? '' : 's'}.`,
      });
    },
  });
}

// Per-USER limiter (keyed by authenticated user id, falling back to IP).
// Mount AFTER requireAuth so req.userId is populated.
function makeUserLimiter(windowMs, max, windowMinutes) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.userId ? `u:${req.userId}` : ipKeyGenerator(req.ip)),
    handler: (_req, res) => {
      res.status(429).json({
        error: `Too many requests. Try again in ${windowMinutes} minute${windowMinutes === 1 ? '' : 's'}.`,
      });
    },
  });
}

module.exports = {
  // General API: 100 req / IP / 15 min. The cap is env-overridable (default
  // unchanged) so local end-to-end test harnesses, which fan out far more than a
  // human ever would, don't trip the limiter; production omits the var and keeps 100.
  api: makeLimiter(15 * 60 * 1000, parseInt(process.env.RATE_LIMIT_API_MAX, 10) || 100, 15),

  // Taste Gap brand autocomplete: one request per pause in typing, so it gets
  // its own budget instead of eating the general API limit. Per IP, because
  // every judge shares one demo account.
  tasteSearch: makeLimiter(15 * 60 * 1000, 300, 15),

  // ── Phase 10: account endpoints (per user) ──────────────────────────────────
  accountDelete:   makeUserLimiter(60 * 60 * 1000, 3, 60),  // 3 / user / hour (paranoia)

  // Login: 10 req / IP / 15 min (per-email limit handled in route)
  login: makeLimiter(15 * 60 * 1000, 10, 15),

  // Registration (send OTP): 5 req / IP / hour
  register: makeLimiter(60 * 60 * 1000, 5, 60),

  // OTP verification: 10 req / IP / 15 min
  otp: makeLimiter(15 * 60 * 1000, 10, 15),

  // Password reset request: 5 req / IP / hour
  reset: makeLimiter(60 * 60 * 1000, 5, 60),

  // Slack slash command / interactions: 60 req / IP / min. Slack requests
  // arrive from Slack's infrastructure; this caps abuse from a single source
  // without throttling normal usage.
  slack: makeLimiter(60 * 1000, 60, 1),
};
