// Capture Phase 9 screenshots against the running server, authenticated as the
// seeded demo user. Usage: node screenshots/take-phase9-shots.js
const { chromium } = require('playwright');
const path = require('path');

const BASE = 'http://localhost:3000';
const OUT = __dirname;

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });

  // Authenticate (cookie persists in the context's jar).
  const login = await context.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' },
  });
  if (!login.ok()) { console.error('Login failed:', login.status(), await login.text()); process.exit(1); }

  const page = await context.newPage();

  async function shot(hash, waitSel, file) {
    await page.goto(`${BASE}/app${hash}`, { waitUntil: 'networkidle' });
    try { await page.waitForSelector(waitSel, { timeout: 8000 }); } catch (_) { console.warn(`  (selector ${waitSel} not found for ${file})`); }
    await page.waitForTimeout(1200); // let stagger animations settle
    const out = path.join(OUT, file);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`  saved ${file}`);
  }

  console.log('Capturing Phase 9 screenshots...');
  await shot('#/deals?tab=roi', '.pattern-card', 'phase9-roi-dashboard.png');
  await shot('#/deals', '.deal-row', 'phase9-deals-list.png');
  await shot('#/', '.roi-widget', 'phase9-dashboard-widget.png');

  // Inline log form, expanded with "Lost" selected so the competitor field shows.
  await page.goto(`${BASE}/app#/deals`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#log-toggle');
  await page.click('#log-toggle');
  await page.waitForSelector('#log-form');
  await page.click('.outcome-btn[data-outcome="lost"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'phase9-log-form.png') });
  console.log('  saved phase9-log-form.png');

  // Deal detail — the "aha" competitor-activity timeline. First row is a loss vs Acme.
  await page.click('.deal-row');
  try { await page.waitForSelector('.deal-detail', { timeout: 8000 }); } catch (_) {}
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'phase9-deal-detail.png'), fullPage: true });
  console.log('  saved phase9-deal-detail.png');

  await browser.close();
  console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
