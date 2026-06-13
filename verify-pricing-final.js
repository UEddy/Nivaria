// Verification + screenshots for the final Team/Business pricing pass.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = `http://localhost:${process.env.PORT || 3100}`;
const OUT  = 'screenshots/pricing-final';
const CRED = { email: 'demo@competitor-shadow.com', password: 'Demo1234!' };
const results = [];
const check = (n, p, d = '') => { results.push({ n, p }); console.log(`${p ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

const TEAM = ['60 competitors with automatic monitoring, twice daily','Multi-user workspace with shared competitive intelligence',"Outreach drafts in each team member's own voice",'Role permissions and team collaboration','Everything in Pro'];
const BIZ = ["Monitor the competitors others can't: bot-protected sites fully covered",'Monitor your entire competitive landscape','Hourly monitoring','API access and advanced webhook delivery','12-month change history','Priority support','Everything in Team'];
const NOTE = 'Launching soon. Waitlist members get 10% off their first 2 months.';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2400 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#pricing .lp-plan-card');
  await page.evaluate(() => document.querySelectorAll('.lp-animate').forEach(e => e.classList.add('lp-visible')));
  await page.waitForTimeout(300);

  const cards = await page.$$eval('#pricing .lp-plan-card', els => els.map(c => ({
    name: c.querySelector('.lp-plan-name')?.textContent.trim(),
    feats: Array.from(c.querySelectorAll('.lp-plan-feat span')).map(s => s.textContent.trim()),
    note: c.querySelector('.lp-plan-waitnote')?.textContent.trim() || null,
  })));
  const team = cards.find(c => c.name === 'Team'), biz = cards.find(c => c.name === 'Business'), free = cards.find(c => c.name === 'Free');

  check('Team bullets exact', JSON.stringify(team.feats) === JSON.stringify(TEAM), team.feats.join(' | '));
  check('Business bullets exact', JSON.stringify(biz.feats) === JSON.stringify(BIZ), biz.feats.join(' | '));
  check('Free 4th bullet is accurate (not "Email delivery")', free.feats[3] === 'Briefs delivered in your dashboard', free.feats[3]);
  check('Team waitlist discount note present', team.note === NOTE, team.note);
  check('Business waitlist discount note present', biz.note === NOTE, biz.note);
  check('No "unlimited" in any card', !cards.some(c => c.feats.join(' ').toLowerCase().includes('unlimited')));
  check('No "custom integration" in any card', !cards.some(c => c.feats.join(' ').toLowerCase().includes('custom integration')));

  // Screenshots: full pricing section desktop
  await page.$eval('#pricing', el => el.scrollIntoView());
  await (await page.$('#pricing')).screenshot({ path: `${OUT}/pricing-desktop.png` });

  // Waitlist modal (Team) shows the discount line
  await page.click('[data-waitlist="team"]');
  await page.waitForTimeout(300);
  const modal = await page.evaluate(() => {
    const ov = document.getElementById('lp-wl-overlay');
    return { open: ov && !ov.hidden, desc: document.getElementById('lp-wl-desc')?.textContent || '' };
  });
  check('Landing waitlist modal opens', modal.open === true);
  check('Waitlist modal body shows 10% discount line', /10% off their first 2 months/.test(modal.desc), modal.desc);
  await (await page.$('#lp-wl-modal')).screenshot({ path: `${OUT}/waitlist-modal.png` });
  await page.keyboard.press('Escape');

  // 375px: no overflow
  await page.setViewportSize({ width: 375, height: 3400 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.querySelectorAll('.lp-animate').forEach(e => e.classList.add('lp-visible')));
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('375px: no horizontal overflow', !overflow);
  await page.$eval('#pricing', el => el.scrollIntoView());
  await page.screenshot({ path: `${OUT}/pricing-375.png`, fullPage: true });

  check('No console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  // ── Upgrade-gate modal states (login, drive showUpgradeModal) ───────────────
  const actx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await actx.request.post(`${BASE}/api/auth/login`, { data: CRED });
  const app = await actx.newPage();
  await app.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await app.waitForTimeout(800);
  async function gate(tier, file) {
    const html = await app.evaluate((t) => {
      window.App = window.App || {}; window.App.subscription = { effectiveTier: t };
      window.showUpgradeModal({ error: 'upgrade_required', message: "You've reached your plan's limit." });
      return (document.getElementById('modal-content') || {}).innerHTML || '';
    }, tier);
    await app.waitForTimeout(250);
    const box = await app.$('#modal-box');
    if (box) await box.screenshot({ path: `${OUT}/${file}` });
    return html;
  }
  const proHtml = await gate('pro', 'gate-pro-to-team.png');
  check('Gate Pro→Team: 60, twice daily', proHtml.includes('60 competitors with automatic monitoring, twice daily'));
  check('Gate Pro→Team: no unlimited', !/unlimited/i.test(proHtml));
  await app.evaluate(() => window.closeModal && window.closeModal());
  await app.waitForTimeout(200);
  const teamHtml = await gate('team', 'gate-team-to-business.png');
  check('Gate Team→Business: entire competitive landscape', teamHtml.includes('Monitor your entire competitive landscape'));
  check('Gate Team→Business: hourly monitoring', teamHtml.includes('Hourly monitoring'));
  check('Gate Team→Business: no unlimited / no custom integration', !/unlimited/i.test(teamHtml) && !/custom integration/i.test(teamHtml));

  await browser.close();
  const passed = results.filter(r => r.p).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
