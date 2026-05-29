// Phase H verification — native share + fallback, long URL handling at 375,
// throttled loading state, desktop regression. Usage:
//   node screenshots/take-phase-h-shots.js          → screenshots/phase-h/
//   node screenshots/take-phase-h-shots.js before   → screenshots/phase-h-before/
//   node screenshots/take-phase-h-shots.js after    → screenshots/phase-h-after/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const TAG = process.argv[2] || '';
const OUT_NAME = TAG ? `phase-h-${TAG}` : 'phase-h';
const OUT = path.join(__dirname, OUT_NAME);
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const seedCtx = await browser.newContext();
  const login = await seedCtx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  if (!login.ok()) throw new Error(`login: ${login.status()}`);
  const storageState = await seedCtx.storageState();
  await seedCtx.close();

  // Find a high-threat brief id so the Copy button exists in the rendered HTML
  // (it's only present when threat is high/medium and is_meaningful !== 0).
  // 13 is the seeded high-threat brief; fall back to scanning if not.
  let briefId = 13;

  // ── 1. Native share — Copy Brief at 375 with navigator.share stubbed ──────
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState, permissions: ['clipboard-read', 'clipboard-write'] });
    // Inject a stub that pretends the native share sheet appeared and was
    // confirmed. Resolves after 200ms so the toast capture is timed correctly.
    await ctx.addInitScript(() => {
      navigator.share = async (data) => {
        window.__sharedPayload = data;
        await new Promise(r => setTimeout(r, 200));
      };
      navigator.canShare = () => true;
    });
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/app#/history/${briefId}`, { waitUntil: 'networkidle', timeout: 20000 });
      await p.waitForSelector('.bc-wrap', { timeout: 12000 });
      await p.waitForTimeout(800);
      // Click the "Copy Brief" button in the headline actions row.
      await p.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /copy brief/i.test(b.textContent || ''));
        if (btn) btn.click();
      });
      await p.waitForTimeout(450); // share stub resolves @200ms + tick for toast
      await p.screenshot({ path: path.join(OUT, 'share-success-375.png'), fullPage: false });
      console.log('  share-success    375: ok');
    } catch (e) { console.log(`  ✗ share-success 375: ${e.message.slice(0,80)}`); }
    await p.close(); await ctx.close();
  }

  // ── 2. Clipboard fallback — same copy action, with navigator.share absent ─
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState, permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(() => {
      // Simulate a browser without Web Share API support.
      delete navigator.share;
      delete navigator.canShare;
    });
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/app#/history/${briefId}`, { waitUntil: 'networkidle', timeout: 20000 });
      await p.waitForSelector('.bc-wrap', { timeout: 12000 });
      await p.waitForTimeout(800);
      await p.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /copy brief/i.test(b.textContent || ''));
        if (btn) btn.click();
      });
      await p.waitForTimeout(450);
      await p.screenshot({ path: path.join(OUT, 'clipboard-fallback-375.png'), fullPage: false });
      console.log('  clipboard-fall   375: ok');
    } catch (e) { console.log(`  ✗ clipboard-fallback 375: ${e.message.slice(0,80)}`); }
    await p.close(); await ctx.close();
  }

  // ── 3. Long URL handling — competitors list at 375 ────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState });
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/app#/competitors`, { waitUntil: 'networkidle', timeout: 20000 });
      await p.waitForSelector('.comp-card, .competitors-card-view', { timeout: 10000 });
      await p.waitForTimeout(800);
      await p.screenshot({ path: path.join(OUT, 'long-url-375.png'), fullPage: true });
      console.log('  long-url         375: ok');
    } catch (e) { console.log(`  ✗ long-url: ${e.message.slice(0,80)}`); }
    await p.close(); await ctx.close();
  }

  // ── 4. Loading state under simulated Slow 3G at 375 ───────────────────────
  // Use CDP throttling. Capture the page during the loading state (within the
  // first few hundred ms) before data arrives.
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState });
    const p = await ctx.newPage();
    try {
      // Throttle to Slow 3G via Chrome DevTools Protocol.
      const client = await p.context().newCDPSession(p);
      await client.send('Network.enable');
      await client.send('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: 50 * 1024,   // 50 KB/s (≈400 kbps)
        uploadThroughput:   50 * 1024,
        latency: 400,                    // 400ms RTT
      });
      // Navigate; don't wait for networkidle, only DOM ready.
      const navP = p.goto(`${BASE}/app#/history`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Capture as soon as the skeleton renders. The Skeleton.* call runs
      // synchronously inside App.route, so by domcontentloaded it should be
      // visible. Take a screenshot at ~600ms after navigation starts.
      await Promise.race([
        navP,
        new Promise(r => setTimeout(r, 1500)),
      ]);
      // If we haven't found a skeleton element yet, wait briefly for one.
      await p.waitForSelector('.skeleton, .loading-state, .spinner', { timeout: 4000 }).catch(() => {});
      await p.screenshot({ path: path.join(OUT, 'loading-state-375.png'), fullPage: true });
      console.log('  loading-state    375: ok');
      // Reset throttling so close() isn't slow.
      await client.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 });
    } catch (e) { console.log(`  ✗ loading-state: ${e.message.slice(0,80)}`); }
    await p.close(); await ctx.close();
  }

  // ── 5. Desktop regression — brief detail at 1440 (Copy Brief, no share) ───
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, storageState });
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/app#/history/${briefId}`, { waitUntil: 'networkidle', timeout: 20000 });
      await p.waitForSelector('.bc-wrap', { timeout: 12000 });
      await p.waitForTimeout(1200);
      await p.screenshot({ path: path.join(OUT, 'desktop-brief-1440.png'), fullPage: false });
      console.log('  desktop-brief   1440: ok');
    } catch (e) { console.log(`  ✗ desktop-brief: ${e.message.slice(0,80)}`); }
    await p.close(); await ctx.close();
  }

  await browser.close();
  console.log(`\nScreenshots: ${OUT}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
