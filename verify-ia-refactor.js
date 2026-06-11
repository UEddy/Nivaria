// Verification + screenshots for the IA refactor (Profile page + sidebar Settings).
// Assumes the server is running on PORT (default 3000) with demo data.
const { chromium } = require('playwright');

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const OUT  = 'screenshots/ia-refactor';
const CRED = { email: 'demo@competitor-shadow.com', password: 'Demo1234!' };

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function gotoSettled(page, hash, sel) {
  await page.goto(`${BASE}/app${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.waitForTimeout(500);
}

(async () => {
  const fs = require('fs');
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  // reducedMotion makes pageTransitionIn() a no-op and disables the card-entry
  // fade, so screenshots capture fully-painted panels instead of frames where
  // headless Chromium has throttled the rAF that restores opacity.
  const context = await browser.newContext({ viewport: { width: 1280, height: 1600 }, reducedMotion: 'reduce' });

  const login = await context.request.post(`${BASE}/api/auth/login`, { data: CRED });
  check('login', login.ok(), `status ${login.status()}`);
  if (!login.ok()) { await browser.close(); process.exit(1); }

  // Pull CSRF token for API mutation tests.
  const me = await (await context.request.get(`${BASE}/api/auth/me`)).json();
  const csrf = me.csrfToken;
  const hdr = { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  // ── 1. Profile page (desktop) ────────────────────────────────────────────
  await gotoSettled(page, '#/profile', '.profile-page');
  const profileText = await page.evaluate(() => document.body.innerText);
  check('Profile: name field', await page.$('#profile-name') != null);
  check('Profile: timezone field labeled detected', /detected automatically/i.test(profileText));
  check('Profile: change-password button', /Change password/i.test(profileText));
  check('Profile: voice profile present', /Voice profile/i.test(profileText));
  check('Profile: email shown', new RegExp(CRED.email.replace('.', '\\.'), 'i').test(profileText));
  await page.screenshot({ path: `${OUT}/profile-desktop.png`, fullPage: true });

  // ── 2. Each Settings section (desktop) ───────────────────────────────────
  const sections = ['workspace', 'integrations', 'notifications', 'billing', 'account'];
  for (const s of sections) {
    await gotoSettled(page, `#/settings/${s}`, '#settings-shell');
    const active = await page.$eval(`.settings-nav__item[data-section="${s}"]`, el => el.classList.contains('is-active'));
    check(`Settings/${s}: active nav highlighted`, active);
    await page.screenshot({ path: `${OUT}/settings-${s}-desktop.png`, fullPage: true });
  }

  // Content spot-checks per section
  await gotoSettled(page, '#/settings/workspace', '#settings-shell');
  check('Workspace: business context', await page.$('#ctx-what-we-sell') != null);

  await gotoSettled(page, '#/settings/integrations', '#settings-shell');
  const integText = await page.evaluate(() => document.body.innerText);
  check('Integrations: calendar present', /Calendar connection/i.test(integText));
  check('Integrations: slack deal logging present', /Slack deal logging/i.test(integText));
  check('Integrations: webhooks present', await page.$('#slack-url') != null && await page.$('#discord-url') != null);

  await gotoSettled(page, '#/settings/notifications', '#settings-shell');
  check('Notifications: briefing toggle', await page.$('#briefings-enabled') != null);
  check('Notifications: lead time', await page.$('#briefing-lead') != null);
  check('Notifications: webhooks NOT here', await page.$('#slack-url') == null);

  await gotoSettled(page, '#/settings/account', '#settings-shell');
  const acctText = await page.evaluate(() => document.body.innerText);
  check('Account: API key present', await page.$('#api-key-display') != null);
  check('Account: DELETE ACCOUNT danger zone', /DELETE ACCOUNT/.test(acctText));
  // Danger zone screenshot (scroll into view)
  const danger = await page.$('.set-card--danger');
  if (danger) await danger.screenshot({ path: `${OUT}/danger-zone.png` });
  check('Account: danger zone styled card', danger != null);

  // Open the delete modal to confirm the hardened flow moved intact (does NOT delete).
  await page.click('.btn-delete-account');
  await page.waitForSelector('#del-confirm-btn', { timeout: 5000 });
  const delDisabled = await page.$eval('#del-confirm-btn', b => b.disabled);
  await page.fill('#del-email', CRED.email);
  await page.fill('#del-pw', 'whatever');
  const delEnabled = await page.$eval('#del-confirm-btn', b => !b.disabled);
  check('Delete modal: confirm gated then enabled', delDisabled && delEnabled);
  await page.screenshot({ path: `${OUT}/delete-modal.png` });
  await page.evaluate(() => closeModal());

  // ── 3. Deep links / default + return params ──────────────────────────────
  await gotoSettled(page, '#/settings', '#settings-shell');
  const defActive = await page.$eval('.settings-nav__item.is-active', el => el.dataset.section);
  check('Deep link #/settings defaults to workspace', defActive === 'workspace', `got ${defActive}`);

  await gotoSettled(page, '#/settings?calendar_connected=google', '#settings-shell');
  const retActive = await page.$eval('.settings-nav__item.is-active', el => el.dataset.section);
  check('Return param calendar_connected -> integrations', retActive === 'integrations', `got ${retActive}`);

  // ── 4. Functional: profile save (name + timezone) ────────────────────────
  const origProfile = await (await context.request.get(`${BASE}/api/auth/me`)).json();
  const newTz = origProfile.timezone === 'America/New_York' ? 'Europe/London' : 'America/New_York';
  const upd = await context.request.put(`${BASE}/api/account/profile`, {
    headers: hdr, data: { firstName: origProfile.first_name || 'Demo', timezone: newTz },
  });
  const updJson = await upd.json();
  check('Profile save: timezone persists', upd.ok() && updJson.user?.timezone === newTz, `tz=${updJson.user?.timezone}`);
  // restore
  await context.request.put(`${BASE}/api/account/profile`, {
    headers: hdr, data: { firstName: origProfile.first_name || 'Demo', timezone: origProfile.timezone || 'UTC' },
  });

  // ── 5. Functional: webhook/briefing DECOUPLING (the server fix) ───────────
  const sub = await (await context.request.get(`${BASE}/api/billing/subscription`)).json();
  const isPro = ['pro', 'team', 'business'].includes(sub.effectiveTier);
  check('demo tier is Pro+ (for webhook test)', isPro, `tier=${sub.effectiveTier}`);

  const before = await (await context.request.get(`${BASE}/api/settings`)).json();
  // Save notifications only (briefings), webhooks omitted.
  await context.request.put(`${BASE}/api/settings`, { headers: hdr, data: { briefings_enabled: 0, briefing_lead_minutes: 60 } });
  // Save webhooks only, briefings omitted.
  const whUrl = 'https://hooks.slack.com/services/T000/B000/decoupletest';
  const whSave = await context.request.put(`${BASE}/api/settings`, { headers: hdr, data: { slack_webhook: whUrl, discord_webhook: null } });
  const after = await (await context.request.get(`${BASE}/api/settings`)).json();
  if (isPro) {
    check('Decouple: webhook save kept briefings_enabled=0', after.settings.briefings_enabled === 0, `got ${after.settings.briefings_enabled}`);
    check('Decouple: webhook save kept lead=60', after.settings.briefing_lead_minutes === 60, `got ${after.settings.briefing_lead_minutes}`);
    check('Decouple: slack webhook saved', after.settings.slack_webhook === whUrl);
    // And: a briefings-only save keeps the webhook.
    await context.request.put(`${BASE}/api/settings`, { headers: hdr, data: { briefings_enabled: 1, briefing_lead_minutes: 30 } });
    const after2 = await (await context.request.get(`${BASE}/api/settings`)).json();
    check('Decouple: briefings save kept slack webhook', after2.settings.slack_webhook === whUrl, `got ${after2.settings.slack_webhook}`);
  }
  // restore original settings
  await context.request.put(`${BASE}/api/settings`, {
    headers: hdr,
    data: {
      slack_webhook: before.settings.slack_webhook || null,
      discord_webhook: before.settings.discord_webhook || null,
      briefings_enabled: before.settings.briefings_enabled ?? 1,
      briefing_lead_minutes: before.settings.briefing_lead_minutes ?? 30,
    },
  });

  // ── 6. Mobile 375px: Profile + each Settings section ─────────────────────
  const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, reducedMotion: 'reduce' });
  // share session
  await mctx.addCookies(await context.cookies());
  const mp = await mctx.newPage();
  const mobileErrors = [];
  mp.on('console', m => { if (m.type() === 'error') mobileErrors.push(m.text()); });
  mp.on('pageerror', e => mobileErrors.push('PAGEERROR: ' + e.message));

  await mp.goto(`${BASE}/app#/profile`, { waitUntil: 'domcontentloaded' });
  await mp.waitForSelector('.profile-page', { timeout: 15000 });
  await mp.waitForTimeout(500);
  const profOverflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('Mobile Profile: no horizontal overflow', !profOverflow);
  await mp.screenshot({ path: `${OUT}/profile-375.png`, fullPage: true });

  for (const s of sections) {
    await mp.goto('about:blank');   // force a full SPA reload each section (avoid same-doc hash flake)
    await mp.goto(`${BASE}/app#/settings/${s}`, { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#settings-shell', { timeout: 15000 });
    await mp.waitForTimeout(550);
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(`Mobile Settings/${s}: no horizontal overflow`, !overflow);
    // touch target height of nav chips
    const minH = await mp.$$eval('.settings-nav__item', els => Math.min(...els.map(e => e.getBoundingClientRect().height)));
    check(`Mobile Settings/${s}: nav touch target >=44px`, minH >= 44, `min ${minH}px`);
    await mp.screenshot({ path: `${OUT}/settings-${s}-375.png`, fullPage: true });
  }

  check('No console errors (desktop)', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('No console errors (mobile)', mobileErrors.length === 0, mobileErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ ' + failed.length + ' FAILED'} — ${results.length} checks. Screenshots in ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
