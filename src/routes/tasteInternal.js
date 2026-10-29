// Localhost-only endpoints for scripts/generate-featured.js, mounted at
// /internal/taste ahead of auth. A request must come from the machine itself
// (no proxy hop: behind Caddy, req.ip is the visitor) and carry the internal
// token, which only something with the server's .env can compute. Anything
// else gets a plain 404.
//
//   GET  /featured        every featured pair and whether its brief is current
//   POST /featured/:key   write that pair's brief with Gemini only and wait;
//                         ?force=1 rewrites a current one

const express = require('express');
const featured = require('../tasteFeatured');
const { tokenMatches } = require('../lib/internalToken');

const router = express.Router();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function localOnly(req, res, next) {
  if (!LOOPBACK.has(req.ip) || !tokenMatches(req.get('x-internal-token'), 'taste-featured')) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

router.use(localOnly);

router.get('/featured', (req, res) => {
  res.json({ pairs: featured.featuredStatus() });
});

// One brief takes up to about three minutes; the script waits for it.
router.post('/featured/:key', async (req, res) => {
  try {
    res.json(await featured.generateFeatured(req.params.key, { force: req.query.force === '1' }));
  } catch (err) {
    console.warn('[taste] featured generation failed: ' + err.message);
    res.json({ key: req.params.key, result: 'failed', error: err.message });
  }
});

module.exports = router;
