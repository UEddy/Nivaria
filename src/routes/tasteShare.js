// Public pages for shared Taste Gap briefs. No login: the unguessable token in
// the URL is the only key (src/tasteShares.js).
//
//   GET /share/:token        the page (src/templates/share.html), with the pair
//                            and headline in its title and Open Graph tags so
//                            the link previews well in Slack and Discord
//   GET /api/share/:token    the brief and chart data the page draws
//
// Both say noindex (header and meta tag), are never cached, and send no
// Referer, so the token does not leak to the map tiles or brand images. A
// revoked or unknown token gets the same page with a "no longer available"
// note, and a 404.

const fs = require('fs');
const path = require('path');
const express = require('express');
const shares = require('../tasteShares');
const limits = require('../middleware/rateLimits');

const router = express.Router();

const TEMPLATE = path.join(__dirname, '../templates/share.html');
let template = null;
const page = () => (template ??= fs.readFileSync(TEMPLATE, 'utf8'));

const attr = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function privateHeaders(res) {
  res.set({
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
}

router.get('/share/:token', limits.tasteShared, (req, res) => {
  privateHeaders(res);
  const run = shares.sharedRun(req.params.token);
  const pair = run ? run.brand + ' vs ' + run.rivals.join(' and ') + (run.city ? ' in ' + run.city : '') : '';
  const title = run ? pair : 'Brief not available';
  const description = run ? run.brief?.headline || 'A brief made with Nivaria.' : 'This shared brief is no longer available.';
  const html = page()
    .replace(/__TITLE__/g, () => attr(title))
    .replace(/__DESCRIPTION__/g, () => attr(description))
    .replace(/__APP_URL__/g, () => attr(shares.appUrl()));
  res.status(run ? 200 : 404).type('html').send(html);
});

router.get('/api/share/:token', limits.tasteShared, (req, res) => {
  privateHeaders(res);
  const run = shares.sharedRun(req.params.token);
  if (!run) return res.status(404).json({ error: 'This shared brief is no longer available.' });
  res.json({ run });
});

module.exports = router;
