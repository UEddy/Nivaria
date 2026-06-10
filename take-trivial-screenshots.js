// Screenshot the customer dashboard + change feed to confirm no trivial labels.
// Assumes the server is already running on PORT (default 3010) against a DB that
// contains demo data PLUS an injected trivial change (see the bash harness).
const { chromium } = require('playwright');

const BASE = `http://localhost:${process.env.PORT || 3010}`;
const OUT  = 'screenshots/trivial-hidden';

(async () => {
  const fs = require('fs');
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });

  // Authenticate via the context request so the session cookie is shared with pages.
  const login = await context.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'demo@nivaria.app', password: 'Demo1234!' },
  });
  console.log('login status:', login.status());

  const page = await context.newPage();

  // Change feed — the surface that used to render "trivial · ai_downgraded".
  await page.goto(`${BASE}/app#/history`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.change-card, .empty-state', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/change-feed.png`, fullPage: true });

  // Assertions straight off the rendered DOM.
  const bodyText = await page.evaluate(() => document.body.innerText);
  const hasTrivialLabel = /trivial\s*·/i.test(bodyText) || /ai_downgraded/i.test(bodyText);
  const hasGateToggle   = /Pre-AI gate/i.test(bodyText);
  const cardThreats = await page.$$eval('.change-card .threat-badge, .change-card [class*="threat"]',
    els => els.map(e => e.textContent.trim().toLowerCase()).filter(Boolean));
  console.log('feed: trivial label present? ', hasTrivialLabel);
  console.log('feed: gate toggle present?  ', hasGateToggle);
  console.log('feed: visible threat labels  ', JSON.stringify([...new Set(cardThreats)]));

  // Dashboard — recent changes widget + counters.
  await page.goto(`${BASE}/app#/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.hero-stats, .empty-state', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/dashboard.png`, fullPage: true });
  const dashText = await page.evaluate(() => document.body.innerText);
  console.log('dashboard: trivial label present?', /trivial\s*·/i.test(dashText) || /ai_downgraded/i.test(dashText));

  // Competitors list — the "X detected" count column.
  await page.goto(`${BASE}/app#/competitors`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.comp-card, table, .empty-state', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/competitors.png`, fullPage: true });

  await browser.close();

  if (hasTrivialLabel || hasGateToggle) {
    console.log('\n❌ FAIL: trivial label or gate toggle still visible');
    process.exit(1);
  }
  console.log('\n✅ PASS: no trivial labels / gate toggle in customer views. Screenshots in', OUT);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
