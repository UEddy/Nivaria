// Phase F verification — Onboarding (steps 1 & 2), Settings (full scroll),
// Add Competitor modal, Log Deal form. Captures at five widths plus form
// audits (inputs with font-size < 16, sub-44 touch on form fields,
// horizontal-overflow checks). Usage:
//   node screenshots/take-phase-f-shots.js          → screenshots/phase-f/
//   node screenshots/take-phase-f-shots.js before   → screenshots/phase-f-before/
//   node screenshots/take-phase-f-shots.js after    → screenshots/phase-f-after/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const TAG = process.argv[2] || '';
const OUT_NAME = TAG ? `phase-f-${TAG}` : 'phase-f';
const OUT = path.join(__dirname, OUT_NAME);
fs.mkdirSync(OUT, { recursive: true });

function pageAudit() {
  const vw = window.innerWidth;
  const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  // Form inputs with font-size below 16px (iOS auto-zooms on focus).
  const smallInputs = [];
  const inputSel = 'input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=submit]):not([type=button]), select, textarea';
  for (const el of document.querySelectorAll(inputSel)) {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    if (r.width === 0 || r.height === 0) continue;
    const fs = parseFloat(st.fontSize);
    if (fs < 16) {
      const d = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
      smallInputs.push({ sel: d, fs: Math.round(fs * 10) / 10, h: Math.round(r.height) });
    }
  }
  // Touch targets: any visible interactive element below 44px square.
  const small = [];
  const seen = new Set();
  const touchSel = 'a, button, input:not([type=hidden]), select, textarea, [role="button"], .voice-radio, label[for]';
  for (const el of document.querySelectorAll(touchSel)) {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) continue;
    if (r.width === 0 || r.height === 0) continue;
    if (r.width < 44 || r.height < 44) {
      const d = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
      const k = d + Math.round(r.width) + 'x' + Math.round(r.height);
      if (seen.has(k)) continue; seen.add(k);
      small.push({ sel: d, w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return {
    vw, docW, overflowX: docW - vw,
    smallInputs: smallInputs.slice(0, 16), smallInputCount: smallInputs.length,
    smallTouchCount: small.length, smallTouch: small.slice(0, 12),
  };
}

(async () => {
  const browser = await chromium.launch();
  const seedCtx = await browser.newContext();
  const login = await seedCtx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@nivaria.app', password: 'Demo1234!' } });
  if (!login.ok()) throw new Error(`login seed: ${login.status()}`);
  const storageState = await seedCtx.storageState();
  await seedCtx.close();

  const widths = [
    { w: 375,  h: 812,  label: '375 iPhone SE',       fname: '375',  isMobile: true  },
    { w: 414,  h: 896,  label: '414 iPhone Pro Max',  fname: '414',  isMobile: true  },
    { w: 768,  h: 1024, label: '768 tablet portrait', fname: '768',  isMobile: true  },
    { w: 1024, h: 768,  label: '1024 small desktop',  fname: '1024', isMobile: false },
    { w: 1440, h: 900,  label: '1440 standard',       fname: '1440', isMobile: false },
  ];

  // Capture pattern: each surface uses a fresh context per width to keep SPA
  // hash routing reliable. Some surfaces require a post-setup step (advance
  // onboarding step / open modal / expand log form).
  const surfaces = [
    {
      id: 'onboarding-1', url: '/app#/onboarding',
      waitFor: '.onboarding-form',
      fname: 'onboarding-step1',
    },
    {
      id: 'onboarding-2', url: '/app#/onboarding',
      waitFor: '.onboarding-form',
      postSetup: async (p) => {
        await p.evaluate(() => { Onboarding._step = 2; Onboarding._draw(); });
        await p.waitForSelector('.voice-radio-group', { timeout: 4000 }).catch(() => {});
      },
      fname: 'onboarding-step2',
    },
    {
      id: 'settings', url: '/app#/settings',
      waitFor: '.settings-stack',
      fname: 'settings',
    },
    {
      id: 'add-competitor', url: '/app#/competitors',
      waitFor: '.competitors-card-view, .competitors-table-view, .empty-state',
      postSetup: async (p) => {
        await p.evaluate(() => Competitors.showAddModal());
        await p.waitForSelector('#comp-name', { timeout: 4000 }).catch(() => {});
      },
      fname: 'add-competitor-modal',
    },
    {
      id: 'log-deal', url: '/app#/deals',
      waitFor: '.log-card',
      postSetup: async (p) => {
        await p.click('#log-toggle', { timeout: 4000 }).catch(() => {});
        await p.evaluate(() => {
          const btn = document.querySelector('.outcome-btn[data-outcome="lost"]');
          if (btn) btn.click();
        });
        await p.waitForTimeout(300);
      },
      fname: 'log-deal-form',
    },
  ];

  const results = {};

  for (const v of widths) {
    for (const s of surfaces) {
      const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2, hasTouch: v.isMobile, isMobile: v.isMobile, storageState });
      const p = await ctx.newPage();
      try {
        // Two-step nav. First land on /app (SPA loads, routes to dashboard).
        // Then SET window.location.hash inside the page — this dispatches a
        // genuine hashchange event the SPA listens for, which goto-with-hash
        // sometimes fails to do (especially at desktop widths where the live
        // clock keeps networkidle busy).
        const hash = s.url.includes('#') ? s.url.split('#')[1] : '/';
        await p.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await p.waitForSelector('#page-root', { timeout: 10000 }).catch(() => {});
        await p.evaluate((h) => { window.location.hash = h; }, hash);
        await p.waitForFunction((sel) => !!document.querySelector(sel), s.waitFor, { timeout: 15000 }).catch(() => {});
        if (s.postSetup) await s.postSetup(p);
        await p.waitForTimeout(900);
        const file = path.join(OUT, `${s.fname}-${v.fname}.png`);
        await p.screenshot({ path: file, fullPage: true });
        const data = await p.evaluate(pageAudit);
        results[`${s.id}-${v.fname}`] = data;
        const tags = [];
        if (data.overflowX > 1) tags.push(`OVERFLOW +${data.overflowX}`);
        if (data.smallInputCount) tags.push(`${data.smallInputCount} small-input`);
        if (data.smallTouchCount) tags.push(`${data.smallTouchCount} small-touch`);
        console.log(`  ${s.id.padEnd(16)} ${v.label.padEnd(22)} vw=${data.vw}  ${tags.join(' · ') || 'clean'}`);
      } catch (e) {
        console.log(`  ✗ ${s.id} @ ${v.fname}: ${e.message.slice(0, 100)}`);
        results[`${s.id}-${v.fname}`] = { error: e.message };
      } finally { await p.close(); await ctx.close(); }
    }
  }

  fs.writeFileSync(path.join(__dirname, '..', `phase-f-report${TAG ? '-' + TAG : ''}.json`), JSON.stringify(results, null, 2));
  await browser.close();
  console.log(`\nScreenshots: ${OUT}`);
  console.log(`Report:      phase-f-report${TAG ? '-' + TAG : ''}.json`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
