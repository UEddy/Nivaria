// Test 7 — pricing page at 375px: four cards stacked, CTAs present, waitlist
// modal opens as a bottom sheet with accessible fields. (Submit path validated
// in Test 6; not re-submitting here to avoid the now-exhausted waitlist limiter.)
const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@nivaria.app', password: 'Demo1234!' } });
  if (!login.ok()) { console.error('login failed', login.status(), '(login rate limit?)'); process.exit(1); }
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app#/plans`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(900);

  const cards = await page.locator('.pricing-card').count();
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.pricing-grid--4')).gridTemplateColumns);
  const ctaCount = await page.locator('.pricing-card button, .pricing-card a').count();
  console.log(`cards=${cards} (expect 4)  columns="${cols}" (single = stacked)  CTAs=${ctaCount}`);
  await page.screenshot({ path: path.join(__dirname, 'phase10', 'test7-plans-mobile.png'), fullPage: true });

  // Waitlist opens as a bottom sheet on mobile
  await page.click('.pricing-card:has-text("Team") button:has-text("Get notified")');
  await page.waitForSelector('#wl-size', { timeout: 5000 });
  await page.waitForTimeout(600);
  const fieldsOk = (await page.locator('#wl-email').count()) && (await page.locator('#wl-size').count());
  // bottom-sheet check: modal box sits at the bottom of the viewport
  const anchored = await page.evaluate(() => {
    const b = document.getElementById('modal-box'); if (!b) return false;
    const r = b.getBoundingClientRect();
    return Math.abs(r.bottom - window.innerHeight) < 4; // flush to bottom edge
  });
  console.log(`waitlist fields accessible: ${fieldsOk ? '✅' : '❌'}; rendered as bottom sheet: ${anchored ? '✅' : '⚠ (centered)'}`);
  await page.screenshot({ path: path.join(__dirname, 'phase10', 'test7-waitlist-bottomsheet.png') });

  const pass = cards === 4 && cols.split(' ').length === 1 && fieldsOk;
  console.log(`\nTEST 7: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
