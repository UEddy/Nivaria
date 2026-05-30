// Phase J — final mobile-pass verification. Modes:
//   matrix : surface x breakpoint overflow/zoom-out coverage  -> phase-j-coverage.json
//   perf   : Slow-3G per-page FCP / DOM-interactive / load     -> phase-j-perf.json
//   final  : 375px full-page screenshots of every surface      -> screenshots/mobile-final/
//   band   : computed-style snapshot of the 720-768 band       -> phase-j-band-<tag>.json
//            (run `band before` then `band after` around the CSS consolidation)
//
// The server caps the general API at 100 req / 15 min (in-memory), so run one
// mode per server restart. Usage: node screenshots/phase-j.js <mode> [tag]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const MODE = process.argv[2] || 'matrix';
const TAG = process.argv[3] || '';

async function login(browser) {
  const ctx = await browser.newContext();
  const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  if (!r.ok()) throw new Error(`login ${r.status()}`);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

// Derive real detail-page IDs from the list DOM so the matrix hits live pages.
async function deriveIds(browser, storageState) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState });
  const p = await ctx.newPage();
  const ids = { comp: null, brief: 13, deal: null };
  try {
    await p.goto(`${BASE}/app#/competitors`, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(600);
    ids.comp = await p.evaluate(() => {
      const a = document.querySelector('a[href^="#/competitors/"]');
      return a ? a.getAttribute('href').split('/').pop() : null;
    });
    await p.goto(`${BASE}/app#/history`, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(600);
    const brief = await p.evaluate(() => {
      const a = document.querySelector('a[href^="#/history/"]');
      return a ? a.getAttribute('href').split('/').pop() : null;
    });
    if (brief) ids.brief = brief;
    await p.goto(`${BASE}/app#/deals`, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(600);
    ids.deal = await p.evaluate(() => {
      const row = document.querySelector('.deal-row');
      // deal rows navigate via onclick navigate('/deals/ID')
      const m = row && row.getAttribute('onclick') && row.getAttribute('onclick').match(/deals\/(\d+)/);
      return m ? m[1] : null;
    });
  } catch (_) {}
  await p.close(); await ctx.close();
  return ids;
}

function surfaces(ids) {
  return [
    ['Dashboard', '/app#/'],
    ['Competitors', '/app#/competitors'],
    ['Competitor detail', `/app#/competitors/${ids.comp || 1}`],
    ['Change Feed', '/app#/history'],
    ['Brief detail', `/app#/history/${ids.brief || 13}`],
    ['Deals (Log & Manage)', '/app#/deals'],
    ['Deals (ROI dashboard)', '/app#/deals?tab=roi'],
    ['Deal detail', `/app#/deals/${ids.deal || 1}`],
    ['Settings', '/app#/settings'],
    ['Pricing', '/app#/pricing'],
    ['Onboarding', '/app#/onboarding'],
    ['404', '/app#/zzz-no-such-page'],
    ['Add Competitor modal', '/app#/competitors'], // modal opened after load
  ];
}

async function measureOverflow(p) {
  return p.evaluate(() => {
    const de = document.documentElement;
    const vw = window.innerWidth;
    const scrollW = Math.max(de.scrollWidth, document.body.scrollWidth);
    // Find the worst offending element extending past the viewport right edge.
    let worst = null, worstRight = vw + 1;
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') return; // scrim/orbs handled separately
      if (r.right > worstRight + 1) {
        worstRight = r.right;
        worst = (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : el.tagName.toLowerCase());
      }
    });
    return { vw, scrollW, overflow: +(scrollW - vw).toFixed(1), worst, worstRight: +worstRight.toFixed(1) };
  });
}

(async () => {
  const browser = await chromium.launch();
  const storageState = await login(browser);

  if (MODE === 'matrix') {
    const ids = await deriveIds(browser, storageState);
    const WIDTHS = [320, 375, 414, 768, 1024, 1440];
    const matrix = { generatedAt: new Date().toISOString(), ids, results: {} };
    for (const width of WIDTHS) {
      const isMobile = width < 1024;
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, hasTouch: isMobile, isMobile, storageState });
      const p = await ctx.newPage();
      for (const [name, route] of surfaces(ids)) {
        try {
          await p.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 25000 });
          await p.waitForTimeout(550);
          if (name === 'Add Competitor modal') {
            await p.evaluate(() => window.Competitors?.showAddModal?.());
            await p.waitForTimeout(450);
          }
          const m = await measureOverflow(p);
          const pass = m.overflow <= 1;            // <=1px tolerance
          (matrix.results[name] = matrix.results[name] || {})[width] = { ...m, pass };
        } catch (e) {
          (matrix.results[name] = matrix.results[name] || {})[width] = { error: e.message.slice(0, 70), pass: false };
        }
      }
      await p.close(); await ctx.close();
    }
    fs.writeFileSync(path.join(__dirname, '..', 'phase-j-coverage.json'), JSON.stringify(matrix, null, 2));
    // Console summary.
    const WID = WIDTHS;
    console.log('SURFACE'.padEnd(26) + WID.map(w => String(w).padStart(7)).join(''));
    let fails = 0;
    for (const [name] of surfaces(ids)) {
      const row = matrix.results[name] || {};
      const cells = WID.map(w => { const c = row[w]; if (!c) return '?'.padStart(7); if (c.error) return 'ERR'.padStart(7); const t = c.pass ? 'ok' : `+${c.overflow}`; if (!c.pass) fails++; return t.padStart(7); });
      console.log(name.padEnd(26) + cells.join(''));
    }
    console.log(`\nTotal fail cells: ${fails}`);
  }

  if (MODE === 'perf') {
    const PAGES = [['Dashboard', '/app#/'], ['Brief detail', '/app#/history/13'], ['Change Feed', '/app#/history'], ['Deals', '/app#/deals'], ['Settings', '/app#/settings']];
    const perf = { generatedAt: new Date().toISOString(), slow3g: {}, desktopBaseline: {} };
    const SLOW3G = { downloadThroughput: 400 * 1024 / 8, uploadThroughput: 400 * 1024 / 8, latency: 400 };

    // Slow 3G @ 375 (mobile).
    for (const [name, route] of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState });
      const p = await ctx.newPage();
      try {
        const client = await p.context().newCDPSession(p);
        await client.send('Network.enable');
        await client.send('Network.emulateNetworkConditions', { offline: false, ...SLOW3G });
        const t0 = Date.now();
        await p.goto(`${BASE}${route}`, { waitUntil: 'load', timeout: 60000 });
        // FCP via PerformanceObserver / paint timing; TTI proxy = domInteractive;
        // also wait for the page's main content selector to confirm interactive.
        const sel = { '/app#/': '.hero-stats-grid, .dashboard-grid', '/app#/history/13': '.bc-wrap', '/app#/history': '.feed-item, .empty-state', '/app#/deals': '.deal-row, .log-card', '/app#/settings': '.set-card' }[route] || 'body';
        await p.waitForSelector(sel, { timeout: 40000 }).catch(() => {});
        const contentT = Date.now() - t0;
        const timing = await p.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] || {};
          const fcp = (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime;
          return {
            fcp: fcp ? Math.round(fcp) : null,
            domInteractive: Math.round(nav.domInteractive || 0),
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
            load: Math.round(nav.loadEventEnd || 0),
          };
        });
        perf.slow3g[name] = { ...timing, contentVisibleMs: contentT };
        console.log(`  3G ${name.padEnd(14)} FCP=${timing.fcp}ms domInteractive=${timing.domInteractive}ms content=${contentT}ms load=${timing.load}ms`);
        await client.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 });
      } catch (e) { perf.slow3g[name] = { error: e.message.slice(0, 80) }; console.log(`  3G ${name}: ${e.message.slice(0,70)}`); }
      await p.close(); await ctx.close();
    }

    // Desktop normal-connection baseline @ 1440.
    for (const [name, route] of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
      const p = await ctx.newPage();
      try {
        const t0 = Date.now();
        await p.goto(`${BASE}${route}`, { waitUntil: 'load', timeout: 30000 });
        const timing = await p.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] || {};
          const fcp = (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime;
          return { fcp: fcp ? Math.round(fcp) : null, domInteractive: Math.round(nav.domInteractive || 0), load: Math.round(nav.loadEventEnd || 0) };
        });
        perf.desktopBaseline[name] = { ...timing, totalMs: Date.now() - t0 };
        console.log(`  DT ${name.padEnd(14)} FCP=${timing.fcp}ms domInteractive=${timing.domInteractive}ms`);
      } catch (e) { perf.desktopBaseline[name] = { error: e.message.slice(0, 80) }; }
      await p.close(); await ctx.close();
    }
    fs.writeFileSync(path.join(__dirname, '..', 'phase-j-perf.json'), JSON.stringify(perf, null, 2));
  }

  if (MODE === 'final') {
    const OUT = path.join(__dirname, 'mobile-final');
    fs.mkdirSync(OUT, { recursive: true });
    const ids = await deriveIds(browser, storageState);
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState });
    const p = await ctx.newPage();
    let n = 0;
    for (const [name, route] of surfaces(ids)) {
      try {
        await p.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 25000 });
        await p.waitForTimeout(700);
        if (name === 'Add Competitor modal') { await p.evaluate(() => window.Competitors?.showAddModal?.()); await p.waitForTimeout(500); }
        const slug = String(++n).padStart(2, '0') + '-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        await p.screenshot({ path: path.join(OUT, slug + '.png'), fullPage: name !== 'Add Competitor modal' });
        console.log(`  ${slug}: ok`);
      } catch (e) { console.log(`  x ${name}: ${e.message.slice(0,70)}`); }
    }
    await p.close(); await ctx.close();
    console.log(`\nScreenshots: ${OUT}`);
  }

  if (MODE === 'band') {
    // Read the computed styles that the legacy 720px block governs, at widths
    // that span the 639/720/768 boundaries. Comparing before vs after the CSS
    // consolidation proves whether visual output changed in the 720-768 band.
    const WIDTHS = [639, 700, 720, 760, 767, 768];
    const out = { tag: TAG, generatedAt: new Date().toISOString(), widths: {} };
    const ctx = await browser.newContext({ viewport: { width: 800, height: 900 }, storageState });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/app#/`, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(500);
    for (const w of WIDTHS) {
      await p.setViewportSize({ width: w, height: 900 });
      await p.waitForTimeout(250);
      out.widths[w] = await p.evaluate(() => {
        const g = (sel, props) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); const o = {}; props.forEach(pr => o[pr] = cs[pr]); return o; };
        return {
          sidebar: g('#sidebar', ['transform', 'width', 'boxShadow']),
          mainWrapper: g('.main-wrapper', ['marginLeft']),
          menuToggle: g('#menu-toggle', ['display']),
          pageContent: g('.page-content', ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']),
          topbar: g('.topbar', ['paddingLeft', 'paddingRight']),
          heroStats: g('.hero-stats-grid', ['gridTemplateColumns']),
          heroValue: g('.hero-value', ['fontSize']),
          sidebarVar: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim(),
        };
      });
    }
    await p.close(); await ctx.close();
    fs.writeFileSync(path.join(__dirname, '..', `phase-j-band-${TAG || 'snap'}.json`), JSON.stringify(out, null, 2));
    console.log(`band snapshot (${TAG}) written for widths ${WIDTHS.join(',')}`);
  }

  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
