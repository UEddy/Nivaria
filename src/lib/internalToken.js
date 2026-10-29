// Token for the server's localhost-only internal endpoints (today, the
// featured-brief generator that scripts/generate-featured.js drives). It is
// derived from SESSION_SECRET, so a script on the server computes it from the
// same .env and nothing new has to be configured or stored.

const crypto = require('crypto');

function internalToken(purpose) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'nivaria-dev').update('internal:' + purpose).digest('hex');
}

function tokenMatches(given, purpose) {
  const expected = Buffer.from(internalToken(purpose));
  const got = Buffer.from(String(given || ''));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

module.exports = { internalToken, tokenMatches };
