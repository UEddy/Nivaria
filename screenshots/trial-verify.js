// Verification + screenshots for: Free tier replaced by 14-day Pro trial.
// Captures: 3-card pricing (desktop + 375px), trial modal, admin waitlist with a
// trial entry. Also asserts the trial submit posts tier_interest='trial' and does
// NOT create/authenticate an account.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'trial');
fs.mkdirSync(OUT, { recursive: true });

const uniqEmail = `trial-shot-${Date.now()}@example.com`;
let captured = null; // the POST body the trial modal sent

(async () => {
  const browser = await chromium.launch();
  const results = [];

  // ── 1. Desktop pricing ─────────────────────────────────────
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dp = await desk.newPage();
  await dp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dp.locator('#pricing').scrollIntoViewIfNeeded();
  await dp.waitForTimeout(700);
  const deskCards = await dp.locator('#pricing .lp-plan-card').count();
  const deskNames = await dp.locator('#pricing .lp-plan-name').allTextContents();
  const deskCols = await dp.evaluate(() =>
    getComputedStyle(document.querySelector('.lp-pricing-grid')).gridTemplateColumns.split(' ').length);
  const hasFree = deskNames.map(s => s.trim().toLowerCase()).includes('free');
  const proCta = (await dp.locator('[data-trial="pro"]').textContent() || '').trim();
  await dp.locator('#pricing').screenshot({ path: path.join(OUT, '1-pricing-desktop.png') });
  results.push(`desktop: cards=${deskCards} (expect 3) names=[${deskNames.map(s=>s.trim()).join(', ')}] cols=${deskCols} hasFree=${hasFree} proCta="${proCta}"`);

  // ── 2. Mobile 375px pricing ────────────────────────────────
  const mob = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mp = await mob.newPage();
  await mp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await mp.locator('#pricing').scrollIntoViewIfNeeded();
  await mp.waitForTimeout(700);
  const mCols = await mp.evaluate(() =>
    getComputedStyle(document.querySelector('.lp-pricing-grid')).gridTemplateColumns.split(' ').length);
  await mp.locator('#pricing').screenshot({ path: path.join(OUT, '2-pricing-mobile-375.png') });
  results.push(`mobile375: cols=${mCols} (expect 1 = stacked)`);

  // ── 3. Trial modal + submit ────────────────────────────────
  const tc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tp = await tc.newPage();
  tp.on('request', req => {
    if (req.url().endsWith('/api/waitlist') && req.method() === 'POST') {
      try { captured = JSON.parse(req.postData() || '{}'); } catch (_) {}
    }
  });
  await tp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await tp.locator('#pricing').scrollIntoViewIfNeeded();
  await tp.click('[data-trial="pro"]');
  await tp.waitForSelector('#lp-wl-overlay:not([hidden])', { timeout: 5000 });
  await tp.waitForTimeout(400);
  const modalTitle = (await tp.locator('#lp-wl-title').textContent() || '').trim();
  const modalDesc  = (await tp.locator('#lp-wl-desc').textContent() || '').trim();
  const modalBtn   = (await tp.locator('#lp-wl-submit').textContent() || '').trim();
  await tp.screenshot({ path: path.join(OUT, '3-trial-modal.png') });

  await tp.fill('#lp-wl-email', uniqEmail);
  const waitResp = tp.waitForResponse(r => r.url().endsWith('/api/waitlist'));
  await tp.click('#lp-wl-submit');
  const resp = await waitResp;
  const status = resp.status();
  const setCookie = (await resp.allHeaders())['set-cookie'] || '';
  await tp.waitForTimeout(500);
  const successMsg = (await tp.locator('#lp-wl-msg').textContent() || '').trim();
  await tp.screenshot({ path: path.join(OUT, '4-trial-success.png') });
  results.push(`trialModal: title="${modalTitle}" btn="${modalBtn}"`);
  results.push(`trialModal desc="${modalDesc}"`);
  results.push(`trialSubmit: status=${status} sentBody=${JSON.stringify(captured)} success="${successMsg}"`);
  results.push(`trialSubmit authCookieSet=${/sid|connect\.sid|session|token/i.test(setCookie)} (expect false = no account/auth)`);

  // ── 4. Admin waitlist (login as demo, admin-overridden for this run) ──
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const login = await adminCtx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  results.push(`adminLogin: ${login.status()}`);
  const ap = await adminCtx.newPage();
  await ap.goto(`${BASE}/admin/waitlist`, { waitUntil: 'networkidle' }).catch(() => {});
  await ap.waitForTimeout(400);
  const trialPills = await ap.locator('.pill-trial').count();
  const bodyText = await ap.locator('body').innerText();
  const showsTrial = /trial/i.test(bodyText);
  await ap.screenshot({ path: path.join(OUT, '5-admin-waitlist.png'), fullPage: true });
  results.push(`admin: trialPills=${trialPills} pageMentionsTrial=${showsTrial}`);

  console.log('\n=== RESULTS ===');
  results.forEach(r => console.log(r));

  const pass =
    deskCards === 3 && !hasFree && deskCols === 3 && proCta === 'Start 14-day free trial' &&
    mCols === 1 &&
    captured && captured.tier_interest === 'trial' && (status === 201 || status === 200) &&
    !/sid|connect\.sid|session|token/i.test(setCookie) &&
    trialPills >= 1;
  console.log(`\nOVERALL: ${pass ? 'PASS' : 'CHECK FAILURES ABOVE'}`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
