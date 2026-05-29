// Phase E verification — Brief detail, Competitor detail, Deal detail at
// five widths, plus per-tab Outreach captures at 375, plus a copy-to-clipboard
// feedback frame. Usage:
//   node screenshots/take-phase-e-shots.js          → screenshots/phase-e/
//   node screenshots/take-phase-e-shots.js before   → screenshots/phase-e-before/
//   node screenshots/take-phase-e-shots.js after    → screenshots/phase-e-after/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const TAG = process.argv[2] || '';
const OUT_NAME = TAG ? `phase-e-${TAG}` : 'phase-e';
const OUT = path.join(__dirname, OUT_NAME);
fs.mkdirSync(OUT, { recursive: true });

function pageAudit() {
  const vw = window.innerWidth;
  const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const sel = 'a, button, input:not([type=hidden]), select, textarea, [role="button"], .outreach-tab, .deals-tab, .outcome-btn, .nav-item';
  const small = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(sel)) {
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
  return { vw, docW, overflowX: docW - vw, smallTouchCount: small.length, smallTouch: small.slice(0, 12) };
}

(async () => {
  const browser = await chromium.launch();

  // Single login, share storage across all viewports.
  const seedCtx = await browser.newContext();
  const login = await seedCtx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  if (!login.ok()) throw new Error(`login seed: ${login.status()} ${await login.text()}`);
  const storageState = await seedCtx.storageState();
  await seedCtx.close();

  const widths = [
    { w: 375,  h: 812,  label: '375 iPhone SE',       fname: '375',  isMobile: true  },
    { w: 414,  h: 896,  label: '414 iPhone Pro Max',  fname: '414',  isMobile: true  },
    { w: 768,  h: 1024, label: '768 tablet portrait', fname: '768',  isMobile: true  },
    { w: 1024, h: 768,  label: '1024 small desktop',  fname: '1024', isMobile: false },
    { w: 1440, h: 900,  label: '1440 standard',       fname: '1440', isMobile: false },
  ];

  const surfaces = [
    { id: 'brief',          url: '/app#/history/1',     waitFor: '.bc-wrap',  fname: 'brief-detail' },
    { id: 'competitor',     url: '/app#/competitors/1', waitFor: '.cd-wrap',  fname: 'competitor-detail' },
    { id: 'deal',           url: '/app#/deals/1',       waitFor: '.deal-detail-head, .deal-detail-name', fname: 'deal-detail' },
  ];

  const results = {};

  for (const v of widths) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2, hasTouch: v.isMobile, isMobile: v.isMobile, storageState });
    for (const s of surfaces) {
      const p = await ctx.newPage();
      try {
        await p.goto(`${BASE}${s.url}`, { waitUntil: 'networkidle', timeout: 20000 });
        await p.waitForSelector(s.waitFor, { timeout: 8000 }).catch(() => {});
        // Brief detail: wait for outreach drafts to either resolve or stay in loading.
        if (s.id === 'brief') {
          await p.waitForTimeout(2200); // playbook generation/load
        } else {
          await p.waitForTimeout(900);
        }
        const file = path.join(OUT, `${s.fname}-${v.fname}.png`);
        await p.screenshot({ path: file, fullPage: true });
        const data = await p.evaluate(pageAudit);
        results[`${s.id}-${v.fname}`] = data;
        console.log(`  ${s.id.padEnd(11)} ${v.label.padEnd(22)} vw=${data.vw} overflowX=${data.overflowX} small-touch=${data.smallTouchCount}`);
      } catch (e) {
        console.log(`  ✗ ${s.id} @ ${v.fname}: ${e.message.slice(0, 100)}`);
        results[`${s.id}-${v.fname}`] = { error: e.message };
      } finally { await p.close(); }
    }
    await ctx.close();
  }

  // ── Per-tab Outreach captures at 375 ───────────────────────────────────────
  // Pick a high/medium-threat brief that has playbooks. Brief #1 may be low.
  // Use a FRESH context per page — the SPA's hash router doesn't reliably
  // re-route on `goto` with just a hash change in a reused context.
  const newMobileCtx = () => browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState });

  const findOutreachBriefId = async () => {
    // Walk recent change ids from highest to 1 — first one with playbook tabs wins.
    for (let id = 25; id >= 1; id--) {
      const ctx = await newMobileCtx();
      const p = await ctx.newPage();
      try {
        await p.goto(`${BASE}/app#/history/${id}`, { waitUntil: 'networkidle', timeout: 15000 });
        await p.waitForSelector('.bc-wrap', { timeout: 4000 }).catch(() => {});
        // Wait for outreach to render (loading → tabs/empty).
        await p.waitForFunction(() => {
          const hasTabs  = document.querySelector('.outreach-tabs');
          const hasEmpty = document.querySelector('.outreach-empty');
          return hasTabs || hasEmpty;
        }, { timeout: 4000 }).catch(() => {});
        const ok = await p.evaluate(() => !!document.querySelector('.outreach-tabs .outreach-tab'));
        if (ok) return id;
      } catch {} finally { await p.close(); await ctx.close(); }
    }
    return null;
  };
  const briefId = await findOutreachBriefId();
  console.log(`  outreach captures using brief id=${briefId || 'NONE FOUND'}`);

  if (briefId) {
    const outreachTabs = ['slack_to_team', 'email_to_prospect', 'followup_email'];
    for (const tab of outreachTabs) {
      const ctx = await newMobileCtx();
      const p = await ctx.newPage();
      try {
        await p.goto(`${BASE}/app#/history/${briefId}`, { waitUntil: 'networkidle', timeout: 20000 });
        await p.waitForSelector('.outreach-tabs .outreach-tab', { timeout: 12000 });
        await p.waitForTimeout(600);
        await p.evaluate((t) => {
          const tabBtn = document.querySelector(`.outreach-tab[data-tab="${t}"]`);
          if (tabBtn) tabBtn.click();
          const tabs = document.querySelector('.outreach-tabs');
          if (tabs) tabs.scrollIntoView({ block: 'center' });
        }, tab);
        await p.waitForTimeout(500);
        await p.screenshot({ path: path.join(OUT, `brief-detail-375-outreach-${tab}.png`), fullPage: true });
        console.log(`  outreach tab ${tab} captured`);
      } catch (e) {
        console.log(`  ✗ outreach ${tab}: ${e.message.slice(0, 100)}`);
      } finally { await p.close(); await ctx.close(); }
    }

    // ── Copy-to-clipboard feedback frame ─────────────────────────────────────
    {
      const ctx2 = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState, permissions: ['clipboard-read', 'clipboard-write'] });
      const p = await ctx2.newPage();
      try {
        await p.goto(`${BASE}/app#/history/${briefId}`, { waitUntil: 'networkidle' });
        await p.waitForSelector('.outreach-panel--active', { timeout: 12000 });
        await p.waitForTimeout(800);
        const clicked = await p.evaluate(() => {
          const panel = document.querySelector('.outreach-panel--active');
          if (!panel) return false;
          const btn = Array.from(panel.querySelectorAll('button')).find(b => /^copy\b/i.test((b.textContent || '').trim()));
          if (!btn) return false;
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return true;
        });
        if (clicked) {
          await p.waitForTimeout(350); // toast + inline ✓ both visible
          await p.screenshot({ path: path.join(OUT, 'copy-feedback-375.png'), fullPage: false });
          console.log('  copy feedback captured');
        } else {
          console.log('  ✗ copy feedback: no panel button found');
        }
      } catch (e) {
        console.log(`  ✗ copy feedback: ${e.message.slice(0, 100)}`);
      } finally { await p.close(); await ctx2.close(); }
    }
  }

  fs.writeFileSync(path.join(__dirname, '..', `phase-e-report${TAG ? '-' + TAG : ''}.json`), JSON.stringify(results, null, 2));
  await browser.close();
  console.log(`\nScreenshots: ${OUT}`);
  console.log(`Report:      phase-e-report${TAG ? '-' + TAG : ''}.json`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
