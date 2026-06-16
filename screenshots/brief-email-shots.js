// Screenshots + parity checks for the brief-email feature:
//  - rendered brief email (desktop + 375px) from the saved HTML
//  - Settings > Notifications panel (accurate copy + Active pill + toggle)
//  - trimmed Pro card on landing and in-app Plans, asserted identical
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'brief-email');
fs.mkdirSync(OUT, { recursive: true });
const emailFile = 'file://' + path.join(OUT, 'brief-email.html').replace(/\\/g, '/');

(async () => {
  const browser = await chromium.launch();
  const results = [];
  let ok = true;
  const check = (c, m) => { results.push(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) ok = false; };

  // ── Email render (desktop + mobile) ────────────────────────
  const ed = await browser.newContext({ viewport: { width: 700, height: 980 }, deviceScaleFactor: 2 });
  const ep = await ed.newPage();
  await ep.goto(emailFile, { waitUntil: 'load' });
  await ep.screenshot({ path: path.join(OUT, 'email-desktop.png'), fullPage: true });
  const em = await browser.newContext({ viewport: { width: 375, height: 900 }, deviceScaleFactor: 2 });
  const emp = await em.newPage();
  await emp.goto(emailFile, { waitUntil: 'load' });
  await emp.screenshot({ path: path.join(OUT, 'email-mobile-375.png'), fullPage: true });

  // ── Landing Pro card ───────────────────────────────────────
  const pub = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  const lp = await pub.newPage();
  await lp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const landingPro = await lp.$$eval('#pricing .lp-plan-card', cards => {
    const c = cards.find(x => x.querySelector('.lp-plan-name')?.textContent.trim() === 'Pro');
    return [...c.querySelectorAll('.lp-plan-feat span')].map(s => s.textContent.replace(/\s+/g, ' ').trim());
  });
  await lp.locator('#pricing .lp-plan-card.featured').screenshot({ path: path.join(OUT, 'pro-card-landing.png') });

  // ── In-app Plans Pro card (authenticated) ──────────────────
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 }, deviceScaleFactor: 2 });
  await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  const consoleErrors = [];
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', e => consoleErrors.push(String(e)));
  await p.goto(`${BASE}/app#/pricing`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.pricing-card', { timeout: 8000 });
  await p.waitForTimeout(400);
  const appPro = await p.$$eval('.pricing-card', cards => {
    const c = cards.find(x => x.querySelector('.pricing-plan')?.textContent.trim() === 'Pro');
    return [...c.querySelectorAll('.pricing-feature')].map(s => s.textContent.replace(/\s+/g, ' ').trim());
  });
  await p.locator('.pricing-card.featured').screenshot({ path: path.join(OUT, 'pro-card-inapp.png') });

  check(!landingPro.some(f => /discord/i.test(f)), 'landing Pro: no Discord');
  check(!landingPro.some(f => /calendar/i.test(f)), 'landing Pro: no Calendar');
  check(landingPro.some(f => /email brief delivery/i.test(f)), 'landing Pro: Email brief delivery present');
  check(JSON.stringify(landingPro) === JSON.stringify(appPro), 'landing Pro features identical to in-app');
  if (JSON.stringify(landingPro) !== JSON.stringify(appPro)) {
    results.push('  landing: ' + JSON.stringify(landingPro));
    results.push('  in-app : ' + JSON.stringify(appPro));
  }

  // ── Settings > Notifications panel ─────────────────────────
  await p.goto(`${BASE}/app#/settings/notifications`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#brief-email-enabled', { timeout: 8000 });
  await p.waitForTimeout(400);
  const panelText = await p.locator('.set-card').filter({ hasText: 'Notifications' }).first().innerText();
  const toggleOn = await p.locator('#brief-email-enabled').isChecked();
  const hasActivePill = await p.locator('.set-pill--active', { hasText: 'Active' }).count();
  check(!/email briefings go to your account address/i.test(panelText), 'old false copy removed');
  check(/whenever a brief is generated/i.test(panelText), 'accurate brief-email copy present');
  check(await p.locator('#brief-email-enabled').count() === 1, 'brief-email toggle present');
  results.push(`toggleChecked=${toggleOn} activePill=${hasActivePill}`);
  await p.locator('.set-card').filter({ hasText: 'Notifications' }).first().screenshot({ path: path.join(OUT, 'settings-notifications.png') });

  // mobile settings panel
  const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}/app#/settings/notifications`, { waitUntil: 'networkidle' });
  await mp.waitForSelector('#brief-email-enabled', { timeout: 8000 });
  await mp.waitForTimeout(400);
  await mp.screenshot({ path: path.join(OUT, 'settings-notifications-375.png'), fullPage: true });

  check(consoleErrors.length === 0, `no console errors (${consoleErrors.length}) ${consoleErrors.slice(0,3).join(' | ')}`);

  console.log('\n=== RESULTS ===');
  results.forEach(r => console.log(r));
  console.log(`\nOVERALL: ${ok ? 'PASS' : 'CHECK FAILURES ABOVE'}`);
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
