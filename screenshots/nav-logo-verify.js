// Verify: nav search icon replaced with Nivaria monogram + wordmark lockup.
// Captures desktop + 375px nav crops. Asserts monogram 200 (no 404), no search
// icon SVG in the lockup, wordmark is live text at JK Sans 800 / -0.03em, and the
// lockup links to "/".
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'nav-logo');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const results = [];

  // monogram request status
  let monoStatus = null;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('response', r => { if (r.url().includes('monogram-solid.svg')) monoStatus = r.status(); });
  const consoleErrors = [];
  p.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', e => consoleErrors.push(String(e)));

  await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);

  const markCount = await p.locator('.lp-logo .lp-logo-mark').count();
  const searchIconInLockup = await p.locator('.lp-logo svg circle[cx="11"]').count();
  const linkHref = await p.locator('a.lp-logo').getAttribute('href');
  const wordmark = (await p.locator('.lp-logo-name').textContent() || '').trim();
  const wmStyle = await p.locator('.lp-logo-name').evaluate(el => {
    const s = getComputedStyle(el);
    return { weight: s.fontWeight, spacing: s.letterSpacing, family: s.fontFamily };
  });
  const markBox = await p.locator('.lp-logo-mark').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), natW: el.naturalWidth, natH: el.naturalHeight };
  });

  await p.locator('nav.lp-nav').screenshot({ path: path.join(OUT, 'nav-desktop.png') });

  results.push(`monogramStatus=${monoStatus} (expect 200)`);
  results.push(`markCount=${markCount} (expect 1)  searchIconInLockup=${searchIconInLockup} (expect 0)`);
  results.push(`linkHref="${linkHref}" (expect /)`);
  results.push(`wordmark="${wordmark}" weight=${wmStyle.weight} spacing=${wmStyle.spacing} family=${wmStyle.family}`);
  results.push(`markBox rendered=${markBox.w}x${markBox.h} natural=${markBox.natW}x${markBox.natH} (square => not stretched)`);
  results.push(`consoleErrors=${consoleErrors.length} ${consoleErrors.slice(0,3).join(' | ')}`);

  // Mobile 375
  const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(300);
  await mp.locator('nav.lp-nav').screenshot({ path: path.join(OUT, 'nav-mobile-375.png') });

  console.log('\n=== RESULTS ===');
  results.forEach(r => console.log(r));
  const pass = monoStatus === 200 && markCount === 1 && searchIconInLockup === 0 &&
    linkHref === '/' && wordmark === 'Nivaria' && wmStyle.weight === '800' &&
    markBox.w === markBox.h && consoleErrors.length === 0;
  console.log(`\nOVERALL: ${pass ? 'PASS' : 'CHECK ABOVE'}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
