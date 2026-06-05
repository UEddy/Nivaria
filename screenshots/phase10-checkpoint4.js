// Phase 10 checkpoint 4 — frontend verification + screenshots.
//   • Plans page at 1440 (4-col) and 375 (stacked)
//   • Settings Plan & Billing: Free (real), Pro (mocked), Cancelled-but-paid (mocked)
//   • Waitlist modals: Team (size dropdown) + Business (use-case textarea)
//   • Tier-gate modal (Free user hits a Pro action → real 402)
//   • Overlay: /api/billing/checkout returns checkoutUrl + LemonSqueezy.Url.Open called
// Usage: node screenshots/phase10-checkpoint4.js  (server running)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'phase10');
fs.mkdirSync(OUT, { recursive: true });
const shot = (p, name) => p.screenshot({ path: path.join(OUT, name + '.png') });
const results = [];
const log = (m) => { console.log(m); results.push(m); };

async function gotoApp(page, hash) {
  await page.goto(`${BASE}/app#/${hash}`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(700);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@nivaria.app', password: 'Demo1234!' } });
  if (!login.ok()) { console.error('Login failed', login.status(), await login.text()); process.exit(1); }

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // ── Plans page desktop (1440, four columns) ──────────────────────────────────
  await gotoApp(page, 'plans');
  const cardCount = await page.locator('.pricing-card').count();
  log(`Plans cards rendered: ${cardCount} ${cardCount === 4 ? '✅' : '❌'}`);
  await shot(page, 'plans-desktop-1440');

  // ── Plans page mobile (375, stacked) ─────────────────────────────────────────
  await page.setViewportSize({ width: 375, height: 812 });
  await gotoApp(page, 'plans');
  await shot(page, 'plans-mobile-375');
  // verify single-column stack (each card full width)
  const gridCols = await page.evaluate(() => getComputedStyle(document.querySelector('.pricing-grid--4')).gridTemplateColumns);
  log(`Plans mobile grid-template-columns: "${gridCols}" ${gridCols.split(' ').length === 1 ? '✅ stacked' : '❌'}`);

  // back to desktop for the rest
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── Waitlist modals (Team + Business) ────────────────────────────────────────
  await gotoApp(page, 'plans');
  await page.click('.pricing-card:has-text("Team") button:has-text("Get notified")');
  await page.waitForSelector('#wl-size', { timeout: 5000 });
  await page.waitForTimeout(500); // let the modal entrance animation settle
  log(`Team waitlist modal has size dropdown: ${await page.locator('#wl-size').count() ? '✅' : '❌'}`);
  await shot(page, 'waitlist-team');
  await page.evaluate(() => window.closeModal());
  await page.waitForTimeout(400);
  await page.click('.pricing-card:has-text("Business") button:has-text("Get notified")');
  await page.waitForSelector('#wl-usecase', { timeout: 5000 });
  await page.waitForTimeout(500);
  log(`Business waitlist modal has use-case textarea: ${await page.locator('#wl-usecase').count() ? '✅' : '❌'}`);
  await shot(page, 'waitlist-business');
  await page.evaluate(() => window.closeModal());
  await page.waitForTimeout(400);

  // ── Tier-gate modal (real 402: Free demo already has >1 competitor) ──────────
  await page.evaluate(() => window.API.addCompetitor({ name: 'GateTest', url: 'https://gate-test.example.com' }).catch(() => {}));
  await page.waitForSelector('.modal-title:has-text("Upgrade to Pro")', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500); // entrance animation
  const gateShown = await page.locator('.modal-title:has-text("Upgrade to Pro")').count();
  log(`Tier-gate modal shown on 402: ${gateShown ? '✅' : '❌'}`);
  await shot(page, 'tier-gate-modal');
  await page.evaluate(() => window.closeModal());
  await page.waitForTimeout(300);

  // ── Overlay: checkout returns checkoutUrl + LemonSqueezy.Url.Open invoked ─────
  await gotoApp(page, 'plans');
  await page.evaluate(() => {
    window.__openCalls = [];
    window.__lemonInited = true; // skip real Setup
    window.LemonSqueezy = window.LemonSqueezy || {};
    window.LemonSqueezy.Url = window.LemonSqueezy.Url || {};
    window.LemonSqueezy.Url.Open = (url) => { window.__openCalls.push(url); };
  });
  let checkoutBody = null;
  try {
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/billing/checkout'), { timeout: 15000 }),
      page.click('.pricing-card:has-text("Pro") button:has-text("Subscribe")'),
    ]);
    checkoutBody = await resp.json().catch(() => ({}));
    await page.waitForTimeout(500);
    const openCalls = await page.evaluate(() => window.__openCalls);
    const status = resp.status();
    log(`POST /api/billing/checkout → ${status}; checkoutUrl present: ${checkoutBody && checkoutBody.checkoutUrl ? '✅' : '❌ (' + JSON.stringify(checkoutBody) + ')'}`);
    log(`LemonSqueezy.Url.Open called with checkoutUrl: ${openCalls[0] && openCalls[0] === (checkoutBody && checkoutBody.checkoutUrl) ? '✅' : '❌ openCalls=' + JSON.stringify(openCalls)}`);
  } catch (e) {
    log(`Checkout flow error: ${e.message}`);
  }

  // ── Settings billing — Free (real demo state) ────────────────────────────────
  await gotoApp(page, 'settings');
  await page.waitForSelector('.set-card__title:has-text("Plan & billing")', { timeout: 8000 }).catch(() => {});
  const billingCard = page.locator('.set-card:has(.set-card__title:has-text("Plan & billing"))');
  await billingCard.scrollIntoViewIfNeeded().catch(() => {});
  log(`Settings billing (Free) shows Upgrade CTA: ${await page.locator('button:has-text("Upgrade to Pro")').count() ? '✅' : '❌'}`);
  await shot(page, 'settings-billing-free');

  // ── Settings billing — Pro active (mock subscription endpoint) ───────────────
  await page.route('**/api/billing/subscription', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tier: 'pro', effectiveTier: 'pro', status: 'active', currentPeriodEnd: '2027-05-31 00:00:00', cancelAtPeriodEnd: false, hasSubscription: true }),
  }));
  await gotoApp(page, 'settings');
  await page.waitForSelector('.set-card__title:has-text("Plan & billing")', { timeout: 8000 }).catch(() => {});
  log(`Settings billing (Pro) shows Manage subscription: ${await page.locator('button:has-text("Manage subscription")').count() ? '✅' : '❌'}`);
  await page.locator('.set-card:has(.set-card__title:has-text("Plan & billing"))').scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, 'settings-billing-pro');

  // ── Settings billing — Cancelled-but-paid (mock) ─────────────────────────────
  await page.unroute('**/api/billing/subscription');
  await page.route('**/api/billing/subscription', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tier: 'pro', effectiveTier: 'pro', status: 'cancelled', currentPeriodEnd: '2026-06-21 00:00:00', cancelAtPeriodEnd: true, hasSubscription: true }),
  }));
  await gotoApp(page, 'settings');
  await page.waitForSelector('.set-card__title:has-text("Plan & billing")', { timeout: 8000 }).catch(() => {});
  log(`Settings billing (Cancelled) shows Resume: ${await page.locator('button:has-text("Resume subscription")').count() ? '✅' : '❌'}`);
  await page.locator('.set-card:has(.set-card__title:has-text("Plan & billing"))').scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, 'settings-billing-cancelled');
  await page.unroute('**/api/billing/subscription');

  log(`\nConsole errors during run: ${consoleErrors.length ? '❌\n  ' + consoleErrors.slice(0, 8).join('\n  ') : 'none ✅'}`);
  log(`Screenshots written to screenshots/phase10/`);
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
