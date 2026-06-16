// Verify: in-app Plans page content matches the landing page tiers (prices, caps,
// features), CTAs are logged-in-appropriate (no "start trial"), and "Manage
// account" routes to Profile. Captures desktop + 375px Plans, plus Profile landing.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'plans-sync');
fs.mkdirSync(OUT, { recursive: true });

const norm = s => s.replace(/\s+/g, ' ').trim();

(async () => {
  const browser = await chromium.launch();
  const results = [];
  let ok = true;
  const check = (cond, msg) => { results.push(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) ok = false; };

  // ── Landing page canonical tiers (unauthenticated) ─────────
  const pub = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const lp = await pub.newPage();
  await lp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const landing = await lp.$$eval('#pricing .lp-plan-card', cards => cards.map(c => ({
    name: c.querySelector('.lp-plan-name')?.textContent.trim(),
    price: c.querySelector('.lp-plan-amount')?.textContent.trim(),
    feats: [...c.querySelectorAll('.lp-plan-feat span')].map(s => s.textContent.replace(/\s+/g, ' ').trim()),
  })));

  // ── In-app Plans page (authenticated) ──────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 }, deviceScaleFactor: 2 });
  await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  const consoleErrors = [];
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', e => consoleErrors.push(String(e)));
  await p.goto(`${BASE}/app#/pricing`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.pricing-card', { timeout: 8000 });
  await p.waitForTimeout(500);

  const app = await p.$$eval('.pricing-card', cards => cards.map(c => ({
    name: c.querySelector('.pricing-plan')?.textContent.trim(),
    price: c.querySelector('.price-amount')?.textContent.trim(),
    feats: [...c.querySelectorAll('.pricing-feature')].map(s => s.textContent.replace(/\s+/g, ' ').trim()),
    cta: c.querySelector('button')?.textContent.replace(/\s+/g, ' ').trim(),
  })));

  const bodyText = await p.locator('.pricing-wrap').innerText();

  // Compare each landing tier to the matching in-app tier
  for (const lt of landing) {
    const at = app.find(a => a.name === lt.name);
    check(!!at, `in-app has "${lt.name}" tier`);
    if (!at) continue;
    check(at.price === lt.price, `${lt.name} price ${at.price} === landing ${lt.price}`);
    check(JSON.stringify(at.feats) === JSON.stringify(lt.feats),
      `${lt.name} features identical (app=${at.feats.length}, landing=${lt.feats.length})`);
    if (JSON.stringify(at.feats) !== JSON.stringify(lt.feats)) {
      results.push(`   landing: ${JSON.stringify(lt.feats)}`);
      results.push(`   in-app : ${JSON.stringify(at.feats)}`);
    }
  }

  check(!app.find(a => a.name === 'Free'), 'no Free card shown');
  check(!/start 14-day free trial/i.test(bodyText), 'no "Start 14-day free trial" copy');
  check(!/custom integration/i.test(bodyText), 'no "custom integrations"');
  check(!/unlimited/i.test(bodyText), 'no "unlimited" count');
  const ctas = app.map(a => `${a.name}:"${a.cta}"`).join('  ');
  results.push(`CTAs => ${ctas}`);
  check(app.some(a => a.cta === 'Current plan'), 'a Current plan CTA is present');
  check(app.filter(a => a.name !== 'Pro').every(a => /current plan|join waitlist/i.test(a.cta)),
    'Team/Business CTAs are Current plan or Join waitlist');

  await p.locator('.pricing-wrap').screenshot({ path: path.join(OUT, 'plans-desktop.png') });

  // ── Manage account -> Profile ──────────────────────────────
  await p.click('.sidebar-manage-link');
  await p.waitForTimeout(700);
  const hash = await p.evaluate(() => location.hash);
  const navProfileActive = await p.locator('.nav-item[data-page="profile"].is-active, .nav-item[data-page="profile"].active').count();
  check(hash === '#/profile', `Manage account routes to Profile (hash=${hash})`);
  await p.screenshot({ path: path.join(OUT, 'manage-account-profile.png'), fullPage: false });

  // ── Mobile 375 Plans ───────────────────────────────────────
  const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}/app#/pricing`, { waitUntil: 'networkidle' });
  await mp.waitForSelector('.pricing-card', { timeout: 8000 });
  await mp.waitForTimeout(500);
  await mp.screenshot({ path: path.join(OUT, 'plans-mobile-375.png'), fullPage: true });

  check(consoleErrors.length === 0, `no console errors (${consoleErrors.length}) ${consoleErrors.slice(0,3).join(' | ')}`);

  console.log('\n=== RESULTS ===');
  results.forEach(r => console.log(r));
  console.log(`\nOVERALL: ${ok ? 'PASS' : 'CHECK FAILURES ABOVE'}`);
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
