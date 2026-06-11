// Verify the expanded public pricing section on the landing page.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = `http://localhost:${process.env.PORT || 3100}`;
const OUT  = 'screenshots/pricing';
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2200 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  // Public, no login.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#pricing .lp-plan-card');

  // Reveal scroll-animated cards.
  await page.evaluate(() => document.querySelectorAll('.lp-animate').forEach(e => e.classList.add('lp-visible')));
  await page.waitForTimeout(300);

  // Expected feature lists (accuracy-checked against tierLimits.js).
  const expected = {
    Free: ['1 competitor tracked', 'Manual checks only', 'AI-generated briefs on detected changes', 'Briefs and change feed in your dashboard'],
    Pro: ['10 competitors monitored', 'Automatic daily monitoring', 'AI briefs with sales talking points and recommended responses', 'AI outreach playbook drafts in your voice', 'Slack and Discord alerts', 'Google Calendar pre-meeting briefings', 'Win/loss correlation and historical pattern analysis', 'ROI dashboard'],
    Team: ['Everything in Pro', 'Multi-user workspace', 'Shared business context and team collaboration', 'Role permissions'],
    Business: ['Everything in Team', 'Monitoring of bot-protected sites', 'Custom integrations', 'Priority support'],
  };

  const cards = await page.$$eval('#pricing .lp-plan-card', els => els.map(c => ({
    name: c.querySelector('.lp-plan-name')?.textContent.trim(),
    price: c.querySelector('.lp-plan-amount')?.textContent.trim(),
    feats: Array.from(c.querySelectorAll('.lp-plan-feat span')).map(s => s.textContent.trim()),
    cta: c.querySelector('.lp-plan-cta')?.textContent.trim(),
    ctaHref: c.querySelector('a.lp-plan-cta')?.getAttribute('href') || null,
    waitlist: c.querySelector('[data-waitlist]')?.getAttribute('data-waitlist') || null,
    featured: c.classList.contains('featured'),
  })));

  check('4 pricing cards present', cards.length === 4, cards.map(c => c.name).join(', '));
  for (const c of cards) {
    const exp = expected[c.name];
    check(`${c.name}: full feature list matches`, exp && JSON.stringify(c.feats) === JSON.stringify(exp),
      exp ? (JSON.stringify(c.feats) === JSON.stringify(exp) ? `${c.feats.length} bullets` : `got ${JSON.stringify(c.feats)}`) : 'unknown tier');
  }
  check('Pro keeps Most Popular emphasis (featured)', cards.find(c => c.name === 'Pro')?.featured === true);
  check('Free CTA → /register', cards.find(c => c.name === 'Free')?.ctaHref === '/register');
  check('Pro CTA → /register', cards.find(c => c.name === 'Pro')?.ctaHref === '/register');
  check('Team CTA → waitlist modal trigger', cards.find(c => c.name === 'Team')?.waitlist === 'team');
  check('Business CTA → waitlist modal trigger', cards.find(c => c.name === 'Business')?.waitlist === 'business');

  // No em/en dashes anywhere in the rendered pricing section (codepoint check).
  const pricingText = await page.$eval('#pricing', el => el.innerText);
  let em = 0, en = 0; for (const ch of pricingText) { if (ch.codePointAt(0) === 0x2014) em++; if (ch.codePointAt(0) === 0x2013) en++; }
  check('no em/en dashes in pricing copy', em === 0 && en === 0, `em=${em} en=${en}`);

  // Waitlist modal opens + closes (Team).
  await page.click('[data-waitlist="team"]');
  await page.waitForTimeout(300);
  const modalState = await page.evaluate(() => {
    const ov = document.getElementById('lp-wl-overlay');
    const title = document.getElementById('lp-wl-title')?.textContent || '';
    return { exists: !!ov, open: ov && !ov.hidden, title };
  });
  check('Team waitlist modal opens', modalState.open === true, modalState.title);
  // Close it again so the focus/scroll-lock resets before the mobile pass.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // Desktop screenshot of the pricing section.
  const section = await page.$('#pricing');
  await section.screenshot({ path: `${OUT}/pricing-desktop.png` });

  // 375px: column behavior + no horizontal overflow.
  await page.setViewportSize({ width: 375, height: 2600 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.querySelectorAll('.lp-animate').forEach(e => e.classList.add('lp-visible')));
  await page.waitForTimeout(300);
  await page.$eval('#pricing', el => el.scrollIntoView());
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('375px: no horizontal overflow', !overflow);
  const cols = await page.evaluate(() => {
    const g = document.querySelector('.lp-pricing-grid-4');
    return getComputedStyle(g).gridTemplateColumns.split(' ').length;
  });
  check('375px: single-column stack', cols === 1, `${cols} column(s)`);
  await page.$eval('#pricing', el => el.scrollIntoView());
  await page.screenshot({ path: `${OUT}/pricing-375.png`, fullPage: true });

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  await browser.close();
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
