const rateLimit = require('express-rate-limit');

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

module.exports = {
  // General API: 100 req / IP / 15 min
  api: makeLimiter(15 * 60 * 1000, 100, 15),

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
