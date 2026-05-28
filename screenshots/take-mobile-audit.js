// Phase A mobile audit — drives every UI surface at 375px (iPhone SE baseline),
// screenshots each to screenshots/mobile-audit/, and measures objective mobile
// problems: horizontal overflow, sub-44px touch targets, sub-14px text, table
// overflow. Writes audit-mobile-findings.json for the human-written report.
//
// Usage: node screenshots/take-mobile-audit.js   (server must be running)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'mobile-audit');
const VIEWPORT = { width: 375, height: 812 };

fs.mkdirSync(OUT, { recursive: true });

// In-page measurement. Self-contained (no outer refs) so Playwright can serialize it.
function runAudit() {
  const vw = window.innerWidth;
  const docW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const overflowX = docW - vw;

  const descr = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      const c = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      if (c) s += '.' + c;
    }
    return s;
  };
  const visible = (el, r, st) =>
    st.display !== 'none' && st.visibility !== 'hidden' && +st.opacity !== 0 && r.width > 0 && r.height > 0;

  const all = Array.from(document.querySelectorAll('body *'));

  // 1. Elements that extend past the right edge of the viewport.
  const wideEls = [];
  for (const el of all) {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, r, st)) continue;
    if (r.right > vw + 1) wideEls.push({ sel: descr(el), w: Math.round(r.width), right: Math.round(r.right) });
  }
  wideEls.sort((a, b) => b.right - a.right);

  // 2. Interactive elements below the 44x44 touch-target minimum.
  const interactiveSel = 'a, button, input:not([type=hidden]), select, textarea, [role="button"], [onclick], .nav-item, .deals-tab, .outcome-btn, .modal-close, .set-linkbtn, .link-btn';
  const smallTouch = [];
  const seenT = new Set();
  for (const el of document.querySelectorAll(interactiveSel)) {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, r, st)) continue;
    if (r.width < 44 || r.height < 44) {
      const d = descr(el);
      const key = d + '|' + Math.round(r.width) + 'x' + Math.round(r.height);
      if (seenT.has(key)) continue;
      seenT.add(key);
      smallTouch.push({ sel: d, w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 22) });
    }
  }

  // 3. Visible elements rendering their own text below 14px.
  const smallText = [];
  const seenS = new Set();
  for (const el of all) {
    const ownsText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!ownsText) continue;
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, r, st)) continue;
    const fs = parseFloat(st.fontSize);
    if (fs < 14) {
      const t = el.textContent.trim().slice(0, 28);
      const key = Math.round(fs * 10) + '|' + t;
      if (seenS.has(key)) continue;
      seenS.add(key);
      smallText.push({ size: Math.round(fs * 10) / 10, sel: descr(el), text: t });
    }
  }
  smallText.sort((a, b) => a.size - b.size);

  // 4. Tables that overflow the viewport.
  const tables = Array.from(document.querySelectorAll('table'));
  const tableOverflow = tables.filter(t => t.scrollWidth > vw + 1).map(t => ({ sel: descr(t), w: Math.round(t.scrollWidth) }));

  return {
    vw, docW, overflowX,
    pageHeight: Math.round(document.documentElement.scrollHeight),
    wideEls: wideEls.slice(0, 10),
    smallTouchCount: smallTouch.length,
    smallTouch: smallTouch.slice(0, 24),
    smallTextCount: smallText.length,
    smallText: smallText.slice(0, 12),
    tableCount: tables.length,
    tableOverflow,
  };
}

(async () => {
  const browser = await chromium.launch();

  // Logged-OUT context for public + auth surfaces.
  const pub = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  // Logged-IN context for app surfaces.
  const appCtx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const login = await appCtx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  if (!login.ok()) { console.error('Login failed:', login.status(), await login.text()); process.exit(1); }

  const results = {};

  async function audit(ctx, id, file, url, { evalSetup, waitMs = 900, postSetup } = {}) {
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      if (evalSetup) { await page.evaluate(evalSetup).catch(e => console.warn(`  setup err ${id}: ${e.message}`)); }
      if (postSetup) { await postSetup(page).catch(e => console.warn(`  postSetup err ${id}: ${e.message}`)); }
      await page.waitForTimeout(waitMs);
      const data = await page.evaluate(runAudit);
      await page.screenshot({ path: path.join(OUT, `${file}.png`), fullPage: true });
      results[id] = data;
      const flags = [];
      if (data.overflowX > 1) flags.push(`OVERFLOW +${data.overflowX}px`);
      if (data.smallTouchCount) flags.push(`${data.smallTouchCount} small-touch`);
      if (data.smallTextCount) flags.push(`${data.smallTextCount} small-text`);
      if (data.tableOverflow.length) flags.push(`${data.tableOverflow.length} table-overflow`);
      console.log(`  ✓ ${id.padEnd(20)} h=${String(data.pageHeight).padStart(5)}  ${flags.join(' · ') || 'clean'}`);
    } catch (e) {
      console.warn(`  ✗ ${id}: ${e.message}`);
      results[id] = { error: e.message };
    } finally {
      await page.close();
    }
  }

  console.log('\n── Public / auth surfaces (375px) ──');
  await audit(pub, 'landing',        'landing',         '/');
  await audit(pub, 'login',          'auth-login',      '/login');
  await audit(pub, 'signup',         'auth-signup',     '/login', { evalSetup: `switchMode('register')` });
  await audit(pub, 'verify-otp',     'auth-verify-otp', '/login', { evalSetup: `(()=>{State.mode='register';State.step=2;State.email='you@company.com';render();})()` });
  await audit(pub, 'forgot-email',   'auth-forgot',     '/login', { evalSetup: `switchMode('forgot')` });
  await audit(pub, 'reset-password', 'auth-reset-pw',   '/login', { evalSetup: `(()=>{State.mode='forgot';State.step=3;render();})()` });

  console.log('\n── App surfaces (375px, authed) ──');
  await audit(appCtx, 'dashboard',         'dashboard',         '/app#/');
  await audit(appCtx, 'competitors',       'competitors',       '/app#/competitors');
  await audit(appCtx, 'competitor-detail', 'competitor-detail', '/app#/competitors/1');
  await audit(appCtx, 'change-feed',       'change-feed',       '/app#/history');
  await audit(appCtx, 'brief-detail',      'brief-detail',      '/app#/history/1');
  await audit(appCtx, 'deals-log',         'deals-log',         '/app#/deals');
  await audit(appCtx, 'deals-roi',         'deals-roi',         '/app#/deals?tab=roi');
  await audit(appCtx, 'deal-detail',       'deal-detail',       '/app#/deals/1');
  await audit(appCtx, 'settings',          'settings',          '/app#/settings');
  await audit(appCtx, 'pricing',           'pricing',           '/app#/pricing');
  await audit(appCtx, 'onboarding',        'onboarding',        '/app#/onboarding');
  await audit(appCtx, 'not-found',         'not-found',         '/app#/zzz-no-such-page');

  console.log('\n── Modals / overlays (375px, authed) ──');
  await audit(appCtx, 'add-competitor-modal', 'modal-add-competitor', '/app#/competitors', {
    postSetup: async (p) => { await p.evaluate(`Competitors.showAddModal()`); },
  });
  await audit(appCtx, 'log-deal-form', 'deals-log-form', '/app#/deals', {
    postSetup: async (p) => {
      await p.click('#log-toggle', { timeout: 5000 }).catch(() => {});
      await p.click('.outcome-btn[data-outcome="lost"]', { timeout: 3000 }).catch(() => {});
    },
  });
  await audit(appCtx, 'delete-confirm-modal', 'modal-delete-confirm', '/app#/competitors', {
    postSetup: async (p) => { await p.evaluate(`Competitors.remove(1, 'Acme Corp')`); },
  });

  fs.writeFileSync(path.join(__dirname, '..', 'audit-mobile-findings.json'), JSON.stringify(results, null, 2));
  console.log('\nWrote audit-mobile-findings.json and', Object.keys(results).length, 'screenshots to screenshots/mobile-audit/');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
