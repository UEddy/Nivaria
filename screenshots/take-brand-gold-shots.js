// Brand refresh verification shots — refined gold accent across key surfaces.
// Captures landing, signup, dashboard, settings, plans, brief detail, waitlist
// modal (desktop 1440) + landing & dashboard at 375px mobile.
// Usage: node screenshots/take-brand-gold-shots.js  (server must be on :3000)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'brand-gold');
fs.mkdirSync(OUT, { recursive: true });

const shot = async (page, name) => {
  const f = path.join(OUT, name + '.png');
  await page.screenshot({ path: f, fullPage: false });
  console.log('  ✓', name);
};

(async () => {
  const browser = await chromium.launch();
  const results = [];
  const safe = async (label, fn) => {
    try { await fn(); results.push([label, 'ok']); }
    catch (e) { results.push([label, 'FAIL: ' + e.message]); console.log('  ✗', label, e.message); }
  };

  // ── Public (desktop 1440) ──
  const pub = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await pub.newPage();

  await safe('landing', async () => {
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(700);
    await shot(p, '01-landing');
  });

  await safe('landing-pricing', async () => {
    // Scroll to the pricing section so the Pro "Most Popular" card is in frame.
    await p.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(e => /most popular/i.test(e.textContent || '') && e.children.length < 5);
      (el || document.querySelector('[class*=pricing]') || document.body).scrollIntoView({ block: 'center' });
    });
    await p.waitForTimeout(500);
    await shot(p, '02-landing-pricing');
  });

  await safe('waitlist-modal', async () => {
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(400);
    // Click the first visible Join Waitlist CTA.
    const btn = p.getByRole('button', { name: /waitlist/i }).first();
    if (await btn.count()) await btn.click({ timeout: 3000 }).catch(() => {});
    else await p.getByText(/join.*waitlist|waitlist/i).first().click({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(600);
    await shot(p, '03-waitlist-modal');
  });

  await safe('signup', async () => {
    await p.goto(BASE + '/signup', { waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    await shot(p, '04-signup');
  });
  await pub.close();

  // ── Public (mobile 375) ──
  const mob = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pm = await mob.newPage();
  await safe('landing-mobile', async () => {
    await pm.goto(BASE + '/', { waitUntil: 'networkidle' });
    await pm.waitForTimeout(700);
    await shot(pm, '05-landing-mobile-375');
  });
  await mob.close();

  // ── Authed (demo account) ──
  const seed = await browser.newContext();
  const login = await seed.request.post(BASE + '/api/auth/login', { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  console.log('login status', login.status());
  const storageState = await seed.storageState();
  await seed.close();

  const app = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
  const a = await app.newPage();
  const go = async (hash) => { await a.goto(BASE + '/app#/' + hash, { waitUntil: 'networkidle' }); await a.waitForTimeout(1100); };

  await safe('dashboard', async () => { await go(''); await shot(a, '06-dashboard'); });
  await safe('settings', async () => { await go('settings'); await shot(a, '07-settings'); });
  await safe('plans', async () => { await go('plans'); await shot(a, '08-plans'); });
  await safe('brief-detail', async () => {
    // Find a brief id from the history feed, then open it.
    await go('history');
    const id = await a.evaluate(() => {
      const link = document.querySelector('a[href*="#/history/"]');
      if (!link) return null; const m = link.getAttribute('href').match(/history\/(\d+)/); return m ? m[1] : null;
    });
    await go('history/' + (id || '13'));
    await shot(a, '09-brief-detail');
  });
  await app.close();

  // ── Authed dashboard (mobile 375) ──
  const appm = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, storageState });
  const am = await appm.newPage();
  await safe('dashboard-mobile', async () => {
    await am.goto(BASE + '/app#/', { waitUntil: 'networkidle' });
    await am.waitForTimeout(1200);
    await shot(am, '10-dashboard-mobile-375');
  });
  await appm.close();

  await browser.close();
  console.log('\nSummary:');
  for (const [l, s] of results) console.log('  ' + l.padEnd(18), s);
  console.log('\nSaved to', OUT);
})();
