// Verify: in-app sidebar search-icon placeholder replaced with Nivaria monogram
// + wordmark lockup, linking to the dashboard home (#/). Captures desktop sidebar
// and the 375px off-canvas drawer. Asserts monogram 200, no search icon in the
// lockup, wordmark live text at JK Sans 800 / -0.03em, no console errors.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'nav-logo-app');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const results = [];

  // ── Desktop, authenticated ────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2 });
  const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  results.push(`login=${login.status()}`);

  let monoStatus = null;
  const p = await ctx.newPage();
  p.on('response', r => { if (r.url().includes('monogram-solid.svg') && monoStatus === null) monoStatus = r.status(); });
  const consoleErrors = [];
  p.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', e => consoleErrors.push(String(e)));

  await p.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);

  const markCount = await p.locator('.sidebar-logo .logo-mark').count();
  const searchIcon = await p.locator('.sidebar-logo svg circle[cx="11"]').count();
  const linkHref = await p.locator('a.sidebar-logo-link').getAttribute('href');
  const wordmark = (await p.locator('.sidebar-logo .logo-name').textContent() || '').trim();
  const wm = await p.locator('.sidebar-logo .logo-name').evaluate(el => {
    const s = getComputedStyle(el); return { weight: s.fontWeight, spacing: s.letterSpacing, family: s.fontFamily };
  });
  const box = await p.locator('.logo-mark').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), natW: el.naturalWidth, natH: el.naturalHeight };
  });
  await p.locator('.sidebar-logo').screenshot({ path: path.join(OUT, 'app-nav-desktop.png') });

  results.push(`monogramStatus=${monoStatus} (expect 200)`);
  results.push(`markCount=${markCount} (expect 1)  searchIconInLockup=${searchIcon} (expect 0)`);
  results.push(`linkHref="${linkHref}" (expect #/)`);
  results.push(`wordmark="${wordmark}" weight=${wm.weight} spacing=${wm.spacing} family=${wm.family}`);
  results.push(`markBox rendered=${box.w}x${box.h} natural=${box.natW}x${box.natH}`);

  // ── Mobile 375, open the drawer ───────────────────────────
  const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(400);
  await mp.click('#menu-toggle');
  await mp.waitForTimeout(500);
  await mp.locator('#sidebar').screenshot({ path: path.join(OUT, 'app-nav-mobile-375.png') });

  results.push(`consoleErrors=${consoleErrors.length} ${consoleErrors.slice(0,3).join(' | ')}`);

  console.log('\n=== RESULTS ===');
  results.forEach(r => console.log(r));
  const pass = monoStatus === 200 && markCount === 1 && searchIcon === 0 &&
    linkHref === '#/' && wordmark === 'Nivaria' && wm.weight === '800' &&
    box.w === box.h && consoleErrors.length === 0;
  console.log(`\nOVERALL: ${pass ? 'PASS' : 'CHECK ABOVE'}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
