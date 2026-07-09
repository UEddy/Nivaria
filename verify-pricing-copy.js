// Screenshots + checks for the page-based pricing copy: Pro reads in pages,
// Team/Business commit to no specific page/competitor number (waitlist).
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = `http://localhost:${process.env.PORT || 3100}`;
const OUT  = 'screenshots/pricing-copy';
const CRED = { email: 'demo@competitor-shadow.com', password: 'Demo1234!' };
const results = [];
const check = (n, p, d = '') => { results.push({ n, p }); console.log(`${p ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // ── Landing pricing cards (public, no login) ────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2200 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#pricing .lp-plan-card');
  await page.evaluate(() => document.querySelectorAll('.lp-animate').forEach(e => e.classList.add('lp-visible')));
  await page.waitForTimeout(300);

  const cards = await page.$$eval('#pricing .lp-plan-card', els => els.map(c => ({
    name: c.querySelector('.lp-plan-name')?.textContent.trim(),
    feats: Array.from(c.querySelectorAll('.lp-plan-feat span')).map(s => s.textContent.trim()),
  })));
  const team = cards.find(c => c.name === 'Team');
  const biz  = cards.find(c => c.name === 'Business');
  // Team is waitlist-only: its page cap is TODO pending cost analysis, so the
  // copy must NOT commit to a specific page/competitor number.
  check('Team card first bullet is the neutral higher-page-volume line', team.feats[0] === 'A higher page volume with automatic monitoring', team.feats[0]);
  check('Team card commits to no specific page/competitor number', !/\b\d+\s+(competitors|pages)\b/i.test(team.feats.join(' ')));
  check('Team card has no "unlimited"', !team.feats.join(' ').toLowerCase().includes('unlimited'));
  check('Business card lists API access bullet', biz.feats.includes('API access and advanced webhook delivery'), biz.feats.join(' | '));
  check('Business card has no "custom integration"', !biz.feats.join(' ').toLowerCase().includes('custom integration'));
  check('Business card commits to no specific page/competitor number', !/\b\d+\s+(competitors|pages)\b/i.test(biz.feats.join(' ')));

  await page.$eval('#pricing', el => el.scrollIntoView());
  await (await page.$('#pricing')).screenshot({ path: `${OUT}/landing-cards-desktop.png` });

  await page.setViewportSize({ width: 375, height: 2600 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.querySelectorAll('.lp-animate').forEach(e => e.classList.add('lp-visible')));
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('375px: no horizontal overflow', !overflow);
  await page.$eval('#pricing', el => el.scrollIntoView());
  await page.screenshot({ path: `${OUT}/landing-cards-375.png`, fullPage: true });
  await ctx.close();

  // ── In-app upgrade-gate modals (login, drive showUpgradeModal per tier) ─────
  const actx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await actx.request.post(`${BASE}/api/auth/login`, { data: CRED });
  const app = await actx.newPage();
  await app.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await app.waitForTimeout(800);

  async function renderGate(tier, file, expectText) {
    const html = await app.evaluate((t) => {
      window.App = window.App || {};
      window.App.subscription = { effectiveTier: t };
      window.showUpgradeModal({ error: 'upgrade_required', message: "You've reached your plan's competitor limit." });
      const box = document.getElementById('modal-content') || document.getElementById('modal-box');
      return box ? box.innerHTML : '';
    }, tier);
    await app.waitForTimeout(250);
    const overlay = await app.$('#modal-overlay.open, .modal-overlay.open, #modal-overlay');
    const target = await app.$('#modal-box') || overlay;
    if (target) await target.screenshot({ path: `${OUT}/${file}` });
    return html;
  }

  const proHtml = await renderGate('pro', 'gate-pro-to-team.png');
  check('Pro→Team modal shows neutral higher-page-volume copy', proHtml.includes('A higher page volume with automatic monitoring'));
  check('Pro→Team modal has no "unlimited"', !/unlimited/i.test(proHtml));
  await app.evaluate(() => window.closeModal && window.closeModal());
  await app.waitForTimeout(200);

  const teamHtml = await renderGate('team', 'gate-team-to-business.png');
  check('Team→Business modal shows "API access and advanced webhook delivery"', teamHtml.includes('API access and advanced webhook delivery'));
  check('Team→Business modal has no "custom integration"', !/custom integration/i.test(teamHtml));

  await browser.close();
  const passed = results.filter(r => r.p).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
