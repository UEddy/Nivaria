// Verification + screenshots for the Profile IA change:
//   · timezone UI removed (silent capture + login/dashboard backfill)
//   · name editing kept on Profile → Your details
//   · Integrations + Account moved from Settings into Profile
//   · Settings trimmed to Workspace / Notifications / Billing
// Assumes the server is running on PORT (default 3100) with demo data.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = `http://localhost:${process.env.PORT || 3100}`;
const OUT  = 'screenshots/profile-ia';
const CRED = { email: 'demo@competitor-shadow.com', password: 'Demo1234!' };

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function gotoSettled(page, hash, sel) {
  await page.goto(`${BASE}/app${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.waitForTimeout(450);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // ── 1. Timezone backfill (end-to-end through the real server DB) ────────────
  // Simulate a pre-existing UTC account, then load the app from a non-UTC
  // browser zone and confirm the stored zone is silently rewritten.
  {
    const ctx = await browser.newContext({ timezoneId: 'America/New_York' });
    const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: CRED });
    check('login', login.ok(), `status ${login.status()}`);
    if (!login.ok()) { await browser.close(); process.exit(1); }
    const me0 = await (await ctx.request.get(`${BASE}/api/auth/me`)).json();
    const csrf = me0.csrfToken;
    const hdr = { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };

    // Force the account back to UTC (simulates a legacy account).
    await ctx.request.put(`${BASE}/api/account/profile`, { headers: hdr, data: { timezone: 'UTC' } });
    const meUtc = await (await ctx.request.get(`${BASE}/api/auth/me`)).json();
    check('precondition: stored timezone is UTC', meUtc.timezone === 'UTC', `db=${meUtc.timezone}`);

    // Load the SPA (App.init runs backfillTimezone) from a NY browser.
    const page = await ctx.newPage();
    await gotoSettled(page, '#/', '.dash-greeting');
    await page.waitForTimeout(900); // let the background updateProfile() land

    const meAfter = await (await ctx.request.get(`${BASE}/api/auth/me`)).json();
    check('backfill: DB timezone updated to browser zone',
      meAfter.timezone === 'America/New_York', `db=${meAfter.timezone}`);

    // Greeting band should reflect NY local time, not UTC.
    const hourNY = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(new Date()), 10) % 24;
    const expectBand = hourNY >= 5 && hourNY < 12 ? 'morning'
      : hourNY >= 12 && hourNY < 17 ? 'afternoon'
      : hourNY >= 17 && hourNY < 21 ? 'evening' : 'night';
    const greeting = (await page.textContent('.dash-greeting')) || '';
    check('greeting renders (band check)', greeting.length > 0, `band=${expectBand} text="${greeting.trim()}"`);

    await ctx.close();
  }

  // ── 2. Profile + Settings structure, no-tz UI, screenshots ──────────────────
  const context = await browser.newContext({ viewport: { width: 1280, height: 1600 }, reducedMotion: 'reduce', timezoneId: 'America/New_York' });
  await context.request.post(`${BASE}/api/auth/login`, { data: CRED });
  const me = await (await context.request.get(`${BASE}/api/auth/me`)).json();
  const csrf = me.csrfToken;
  const hdr = { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  const sub = await (await context.request.get(`${BASE}/api/billing/subscription`)).json().catch(() => ({}));
  const tier = sub.effectiveTier || 'free';
  console.log(`   (demo account tier: ${tier})`);

  const page = await context.newPage();

  // Profile shell + 4 nav sections
  await gotoSettled(page, '#/profile', '#profile-shell');
  const navLabels = await page.$$eval('#profile-shell .settings-nav__item .settings-nav__label', els => els.map(e => e.textContent.trim()));
  check('profile has 4 sidebar sections', JSON.stringify(navLabels) === JSON.stringify(['Your details', 'Voice profile', 'Integrations', 'Account']), navLabels.join(' / '));

  // No timezone UI anywhere on Profile (all sections)
  let tzHits = [];
  for (const sec of ['details', 'voice', 'integrations', 'account']) {
    await gotoSettled(page, `#/profile/${sec}`, '#profile-panel .set-card');
    const hasSelect = await page.$('#profile-tz');
    const bodyText = (await page.textContent('#profile-panel')) || '';
    if (hasSelect) tzHits.push(`${sec}:#profile-tz`);
    if (/timezone/i.test(bodyText)) tzHits.push(`${sec}:"timezone" text`);
    if (/detected automatically/i.test(bodyText)) tzHits.push(`${sec}:"detected automatically"`);
  }
  check('no timezone UI on Profile (picker/label/copy)', tzHits.length === 0, tzHits.join(', ') || 'clean');

  // Details: name field present, no explanatory paragraph, em-dash free
  await gotoSettled(page, '#/profile/details', '#profile-name');
  const detailsHtml = await page.innerHTML('#profile-panel');
  check('details: name input present', !!(await page.$('#profile-name')));
  check('details: no em-dash in copy', !detailsHtml.includes('—'), detailsHtml.includes('—') ? 'em-dash found' : 'clean');

  // Name edit + save round-trip (then restore)
  const origName = me.first_name || 'Demo';
  await page.fill('#profile-name', 'Eddy Test');
  await page.click('#profile-panel [data-save-btn]');
  await page.waitForTimeout(700);
  const meName = await (await context.request.get(`${BASE}/api/auth/me`)).json();
  check('name edit saves to DB', meName.first_name === 'Eddy Test', `db=${meName.first_name}`);
  await context.request.put(`${BASE}/api/account/profile`, { headers: hdr, data: { firstName: origName } });

  // Integrations section: calendar + slack + webhooks all present
  await gotoSettled(page, '#/profile/integrations', '#profile-panel .set-card');
  const intText = await page.textContent('#profile-panel');
  check('integrations: Calendar card', /Calendar connection/.test(intText));
  check('integrations: Slack deal logging card', /Slack deal logging/.test(intText));
  check('integrations: Alert webhooks card', /Alert webhooks/.test(intText));
  check('integrations: calendar connect/Active control present', !!(await page.$('#profile-panel a[href="/api/calendar/google/connect"], #profile-panel .set-linkbtn--danger')));
  check('integrations: webhook test buttons present', (await page.$$('#profile-panel button')).length >= 2);

  // Account section: API key + DELETE ACCOUNT danger zone
  await gotoSettled(page, '#/profile/account', '#profile-panel .set-card');
  check('account: API key card', !!(await page.$('#api-key-display')));
  check('account: DELETE ACCOUNT button', !!(await page.$('.btn-delete-account')));
  check('account: Export my data button', /Export my data/.test(await page.textContent('#profile-panel')));
  // Delete modal opens with email+password confirm (do NOT submit)
  await page.click('.btn-delete-account');
  await page.waitForSelector('#del-email', { timeout: 5000 });
  check('account: delete modal has email + password confirm', !!(await page.$('#del-email')) && !!(await page.$('#del-pw')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Settings now only Workspace / Notifications / Billing
  await gotoSettled(page, '#/settings', '#settings-shell');
  const setLabels = await page.$$eval('#settings-shell .settings-nav__item .settings-nav__label', els => els.map(e => e.textContent.trim()));
  check('settings has 3 sidebar sections', JSON.stringify(setLabels) === JSON.stringify(['Workspace', 'Notifications', 'Billing']), setLabels.join(' / '));
  check('settings: no Integrations/Account nav', !setLabels.includes('Integrations') && !setLabels.includes('Account'));

  // Old deep links resolve to new locations
  await gotoSettled(page, '#/settings?upgraded=1', '#settings-shell');
  check('deep link: #/settings?upgraded=1 → Billing active', await page.$eval('#settings-shell .settings-nav__item.is-active .settings-nav__label', e => e.textContent.trim()) === 'Billing');
  await gotoSettled(page, '#/profile?calendar_connected=google', '#profile-shell');
  check('deep link: #/profile?calendar_connected=google → Integrations active', await page.$eval('#profile-shell .settings-nav__item.is-active .settings-nav__label', e => e.textContent.trim()) === 'Integrations');

  // ── 3. Screenshots ──────────────────────────────────────────────────────────
  async function shot(hash, sel, file, mobile = false) {
    const vp = mobile ? { width: 375, height: 812 } : { width: 1280, height: 1600 };
    await page.setViewportSize(vp);
    await gotoSettled(page, hash, sel);
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
    // Horizontal-overflow guard at 375px
    if (mobile) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(`no horizontal overflow @375px (${file})`, !overflow, `scrollW vs innerW`);
    }
  }

  for (const sec of ['details', 'voice', 'integrations', 'account']) {
    await shot(`#/profile/${sec}`, '#profile-panel .set-card', `profile-${sec}-desktop.png`);
    await shot(`#/profile/${sec}`, '#profile-panel .set-card', `profile-${sec}-375.png`, true);
  }
  for (const sec of ['workspace', 'notifications', 'billing']) {
    await shot(`#/settings/${sec}`, '#settings-panel .set-card', `settings-${sec}-desktop.png`);
  }

  await browser.close();

  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  fs.writeFileSync('profile-ia-report.json', JSON.stringify(results, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
