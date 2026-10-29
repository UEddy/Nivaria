// npm postinstall: install Playwright's Chromium only when page monitoring is
// on for this install (ENABLE_SCRAPER=true). A Taste Gap deploy never scrapes,
// and the browser plus its system packages are hundreds of megabytes, so by
// default the install is skipped. To install it later on a machine that
// needs it: ENABLE_SCRAPER=true npm rebuild, or npx playwright install
// --with-deps chromium.

const { spawnSync } = require('child_process');
const path = require('path');

if (String(process.env.ENABLE_SCRAPER || '').trim().toLowerCase() !== 'true') {
  console.log('postinstall: skipping the Playwright browser install (set ENABLE_SCRAPER=true to install it)');
  process.exit(0);
}

const cli = path.join(__dirname, '..', 'node_modules', 'playwright', 'cli.js');
const r = spawnSync(process.execPath, [cli, 'install', '--with-deps', 'chromium'], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
