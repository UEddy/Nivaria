// Phase B verification — drives the new hamburger drawer through every close
// path the spec requires and captures before/after screenshots at 375px and
// 1440px. Writes results to phase-b-report.json (artifact).
//
// Usage: node screenshots/take-phase-b-shots.js   (server must be running)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'phase-b');
fs.mkdirSync(OUT, { recursive: true });

const results = { interactions: {}, dashboard: {} };
const log = (n, ok, detail) => { results.interactions[n] = { ok, detail }; console.log(`  ${ok ? '✓' : '✗'} ${n}${detail ? ` — ${detail}` : ''}`); };

async function authed(browser, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: viewport.width < 768, isMobile: viewport.width < 768 });
  const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  if (!login.ok()) throw new Error(`login: ${login.status()}`);
  return ctx;
}

async function isDrawerOpen(page) {
  return await page.evaluate(() => document.getElementById('sidebar')?.classList.contains('open') === true);
}
async function openDrawer(page) {
  await page.click('#menu-toggle');
  await page.waitForTimeout(380); // slide-in transition (.28s + margin)
}

(async () => {
  const browser = await chromium.launch();

  // ── 375px ─────────────────────────────────────────────────────────────────
  console.log('\n── 375 × 812 (iPhone SE baseline) ──');
  const ctxM = await authed(browser, { width: 375, height: 812 });
  const m = await ctxM.newPage();
  await m.goto(`${BASE}/app#/`, { waitUntil: 'networkidle' });
  await m.waitForSelector('.hero-stat-label', { timeout: 8000 }).catch(() => {});
  await m.waitForTimeout(900);

  // Capture closed state.
  await m.screenshot({ path: path.join(OUT, '375-dashboard-closed.png'), fullPage: true });
  log('initial state: drawer closed', !(await isDrawerOpen(m)));

  // 1) Tap toggle → opens.
  await openDrawer(m);
  log('tap toggle opens drawer', await isDrawerOpen(m));

  // Capture open state with scrim visible.
  await m.screenshot({ path: path.join(OUT, '375-dashboard-drawer-open.png'), fullPage: false });

  // ARIA checks while open.
  const ariaOpen = await m.evaluate(() => ({
    toggleExpanded: document.getElementById('menu-toggle').getAttribute('aria-expanded'),
    drawerModal:    document.getElementById('sidebar').getAttribute('aria-modal'),
    bodyClass:      document.body.classList.contains('drawer-open'),
    scrimVisible:   document.getElementById('sidebar-scrim').classList.contains('visible'),
    focusedIsNav:   document.activeElement?.classList.contains('nav-item') === true,
  }));
  log('ARIA: aria-expanded="true" on toggle',   ariaOpen.toggleExpanded === 'true');
  log('ARIA: aria-modal="true" on drawer',      ariaOpen.drawerModal === 'true');
  log('ARIA: body has .drawer-open',            ariaOpen.bodyClass);
  log('ARIA: scrim has .visible class',         ariaOpen.scrimVisible);
  log('Focus: first nav-item receives focus',   ariaOpen.focusedIsNav);

  // 2) Tap scrim → closes. Sidebar covers ~322px of the 375-wide viewport, so
  //    the visible scrim is the right-edge strip — click into that strip.
  await m.mouse.click(360, 400);
  await m.waitForTimeout(380);
  log('tap scrim closes drawer', !(await isDrawerOpen(m)));

  // 3) Tap X button → closes.
  await openDrawer(m);
  await m.click('#sidebar-close');
  await m.waitForTimeout(380);
  log('tap X button closes drawer', !(await isDrawerOpen(m)));

  // 4) Escape key → closes.
  await openDrawer(m);
  await m.keyboard.press('Escape');
  await m.waitForTimeout(120);
  log('Escape key closes drawer', !(await isDrawerOpen(m)));

  // 5) Tap a nav-item → navigates and auto-closes.
  await openDrawer(m);
  await m.click('a.nav-item[data-page="competitors"]');
  await m.waitForTimeout(400);
  const navClosed = !(await isDrawerOpen(m));
  const navUrl = await m.evaluate(() => location.hash);
  log('tap nav-item navigates + auto-closes', navClosed && navUrl === '#/competitors', `hash=${navUrl} closed=${navClosed}`);

  // Return to dashboard for next test.
  await m.goto(`${BASE}/app#/`, { waitUntil: 'networkidle' });
  await m.waitForTimeout(600);

  // 6) Swipe-left gesture → closes. Synthesized via CDP touch events.
  await openDrawer(m);
  const sb = await m.locator('#sidebar');
  const box = await sb.boundingBox();
  // Start near the right edge of the open drawer, swipe left ~120px.
  const x0 = Math.min(box.x + box.width - 30, 300);
  const y0 = box.y + box.height / 2;
  await m.touchscreen.tap(x0, y0).catch(() => {}); // make sure touch is awake
  // Synthesize the swipe by dispatching the same touch events the drawer listens for.
  await m.evaluate(({ x0, y0 }) => {
    const sb = document.getElementById('sidebar');
    const mk = (type, cx) => new TouchEvent(type, {
      bubbles: true, cancelable: true,
      touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: sb, clientX: cx, clientY: y0 })],
      changedTouches: [new Touch({ identifier: 1, target: sb, clientX: cx, clientY: y0 })],
    });
    sb.dispatchEvent(mk('touchstart', x0));
    sb.dispatchEvent(mk('touchmove',  x0 - 120));
    sb.dispatchEvent(mk('touchend',   x0 - 120));
  }, { x0, y0 });
  await m.waitForTimeout(120);
  log('swipe-left gesture closes drawer', !(await isDrawerOpen(m)));

  // 7) Toggle ARIA returns to closed state.
  const ariaClosed = await m.evaluate(() => ({
    toggleExpanded: document.getElementById('menu-toggle').getAttribute('aria-expanded'),
    drawerHidden:   document.getElementById('sidebar').getAttribute('aria-hidden'),
    bodyClass:      document.body.classList.contains('drawer-open'),
  }));
  log('ARIA: aria-expanded="false" after close',   ariaClosed.toggleExpanded === 'false');
  log('ARIA: aria-hidden="true" on closed drawer', ariaClosed.drawerHidden === 'true');
  log('ARIA: body.drawer-open removed',            !ariaClosed.bodyClass);

  // Mobile dashboard layout sanity check (Phase C fold-in).
  results.dashboard.mobile = await m.evaluate(() => ({
    vw: window.innerWidth,
    docW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
    menuToggleVisible: getComputedStyle(document.getElementById('menu-toggle')).display !== 'none',
    sidebarHiddenInFlow: getComputedStyle(document.getElementById('sidebar')).transform !== 'none',
    liveClockHidden: getComputedStyle(document.querySelector('.live-clock-wrap')).display === 'none',
    themeToggleHidden: getComputedStyle(document.querySelector('.theme-toggle')).display === 'none',
  }));
  console.log(`  dashboard@375 vw=${results.dashboard.mobile.vw} overflowX=${results.dashboard.mobile.overflowX} liveClockHidden=${results.dashboard.mobile.liveClockHidden}`);

  await ctxM.close();

  // ── 1440px desktop regression check ───────────────────────────────────────
  console.log('\n── 1440 × 900 (desktop regression check) ──');
  const ctxD = await authed(browser, { width: 1440, height: 900 });
  const d = await ctxD.newPage();
  await d.goto(`${BASE}/app#/`, { waitUntil: 'networkidle' });
  await d.waitForSelector('.hero-stat-label', { timeout: 8000 }).catch(() => {});
  await d.waitForTimeout(900);
  await d.screenshot({ path: path.join(OUT, '1440-dashboard.png'), fullPage: true });

  results.dashboard.desktop = await d.evaluate(() => ({
    vw: window.innerWidth,
    overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
    menuToggleHidden:  getComputedStyle(document.getElementById('menu-toggle')).display === 'none',
    sidebarVisible:    document.getElementById('sidebar').getBoundingClientRect().width > 0,
    mainOffsetByNavW:  Math.round(document.querySelector('.main-wrapper').getBoundingClientRect().left),
    liveClockVisible:  getComputedStyle(document.querySelector('.live-clock-wrap')).display !== 'none',
    themeToggleVisible:getComputedStyle(document.querySelector('.theme-toggle')).display !== 'none',
  }));
  console.log('  ', JSON.stringify(results.dashboard.desktop));
  log('1440: menu-toggle hidden',     results.dashboard.desktop.menuToggleHidden);
  log('1440: sidebar visible',        results.dashboard.desktop.sidebarVisible);
  log('1440: live clock still shown', results.dashboard.desktop.liveClockVisible);
  log('1440: theme toggle still shown', results.dashboard.desktop.themeToggleVisible);
  log('1440: main-wrapper offset by sidebar width (260)', results.dashboard.desktop.mainOffsetByNavW === 260, `offset=${results.dashboard.desktop.mainOffsetByNavW}`);

  await ctxD.close();
  await browser.close();

  const all = Object.values(results.interactions);
  const pass = all.filter(x => x.ok).length;
  const fail = all.length - pass;
  results.summary = { pass, fail };
  fs.writeFileSync(path.join(__dirname, '..', 'phase-b-report.json'), JSON.stringify(results, null, 2));
  console.log(`\n══════════ Phase B: ${pass} passed, ${fail} failed ══════════`);
  console.log('Screenshots:', OUT);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
