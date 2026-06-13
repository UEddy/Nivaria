// Verification + screenshots for the UX commit:
//   1. Profile "Account" -> "Security" (password moved in), 2. page descriptors,
//   3. empty-state guidance, 4. save-success feedback.
// Empty states are exercised through real render code by stubbing the API
// responses (route interception) to look like a brand-new account.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = `http://localhost:${process.env.PORT || 3100}`;
const OUT  = 'screenshots/ux-pass';
const CRED = { email: 'demo@competitor-shadow.com', password: 'Demo1234!' };
const results = [];
const check = (n, p, d = '') => { results.push({ n, p }); console.log(`${p ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

async function settle(page, hash, sel) {
  await page.goto(`${BASE}/app${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.waitForTimeout(400);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // ── Real-data context: structure + descriptors + save feedback ──────────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  await ctx.request.post(`${BASE}/api/auth/login`, { data: CRED });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  // Profile sidebar + descriptor
  await settle(page, '#/profile', '#profile-shell');
  const nav = await page.$$eval('#profile-shell .settings-nav__label', els => els.map(e => e.textContent.trim()));
  check('Profile sidebar = Your details, Voice profile, Integrations, Security',
    JSON.stringify(nav) === JSON.stringify(['Your details', 'Voice profile', 'Integrations', 'Security']), nav.join(' / '));
  const profSub = await page.textContent('.profile-page .settings-page-subtitle');
  check('Profile descriptor text', profSub.trim() === 'Your personal details and how Nivaria represents you', profSub.trim());

  // Details = name + email, NO password button
  await settle(page, '#/profile/details', '#profile-panel .set-card');
  const detailsText = await page.textContent('#profile-panel');
  check('Details has name field', !!(await page.$('#profile-name')));
  check('Details shows email (read-only)', /Email/.test(detailsText) && detailsText.includes('@'));
  check('Details no longer has the password change button', !detailsText.includes('Change password'));
  await page.screenshot({ path: `${OUT}/profile-details.png` });

  // Security = password + API key + danger zone
  await settle(page, '#/profile/security', '#profile-panel .set-card');
  const secText = await page.textContent('#profile-panel');
  check('Security tab active', await page.$eval('#profile-shell .settings-nav__item.is-active .settings-nav__label', e => e.textContent.trim()) === 'Security');
  check('Security has Change password button', secText.includes('Change password'));
  check('Security has API key', !!(await page.$('#api-key-display')));
  check('Security has DELETE ACCOUNT danger zone', !!(await page.$('.btn-delete-account')));
  await page.screenshot({ path: `${OUT}/profile-security.png` });

  // Delete flow still opens its confirm modal (do not submit)
  await page.click('.btn-delete-account');
  await page.waitForSelector('#del-email', { timeout: 5000 });
  check('Delete flow modal opens (email + password confirm)', !!(await page.$('#del-email')) && !!(await page.$('#del-pw')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Old #/profile/account alias resolves to Security
  await settle(page, '#/profile/account', '#profile-panel .set-card');
  check('Old #/profile/account resolves to Security', await page.$eval('#profile-shell .settings-nav__item.is-active .settings-nav__label', e => e.textContent.trim()) === 'Security');

  // Settings descriptor
  await settle(page, '#/settings/workspace', '#settings-panel .set-card');
  const setSub = await page.textContent('.settings-page .settings-page-subtitle');
  check('Settings descriptor text', setSub.trim() === 'Workspace configuration, billing, and company context', setSub.trim());

  // Business context placeholders carry the realistic examples
  const phWhat = await page.getAttribute('#ctx-what-we-sell', 'placeholder');
  const phIcp  = await page.getAttribute('#ctx-target-icp', 'placeholder');
  const phPos  = await page.getAttribute('#ctx-our-positioning', 'placeholder');
  check('Workspace "what we sell" placeholder is an example', /^Example:/.test(phWhat), phWhat);
  check('Workspace ICP placeholder is an example', /^Example:/.test(phIcp));
  check('Workspace positioning placeholder is an example', /Linear and Asana/.test(phPos), phPos);

  // Add-competitor modal placeholder + helper
  await settle(page, '#/competitors', '.page-root, #page-root, .competitors-card-view, .empty-state, table, .card');
  await page.evaluate(() => window.Competitors && Competitors.showAddModal && Competitors.showAddModal());
  await page.waitForSelector('#comp-url', { timeout: 5000 });
  const compPh = await page.getAttribute('#comp-url', 'placeholder');
  const compHint = await page.textContent('.modal-body');
  check('Add-competitor URL placeholder updated', compPh === 'https://competitor.com/pricing or /changelog', compPh);
  check('Add-competitor helper line updated', /Pricing pages, changelogs, and blogs work best\. Heavily bot-protected sites may not be monitorable on this plan\./.test(compHint));
  await page.screenshot({ path: `${OUT}/add-competitor-modal.png` });
  await page.keyboard.press('Escape');

  // Save-success feedback: save the name and capture the toast
  await settle(page, '#/profile/details', '#profile-name');
  const curName = await page.inputValue('#profile-name');
  await page.fill('#profile-name', curName || 'Demo');
  await page.fill('#profile-name', (curName || 'Demo') + ' ');     // make it dirty
  await page.fill('#profile-name', curName || 'Demo');
  await page.click('#profile-panel [data-save-btn]');
  await page.waitForSelector('.toast.toast-success', { timeout: 5000 });
  const toastTxt = await page.textContent('.toast.toast-success');
  check('Save produces a success toast', /saved/i.test(toastTxt), toastTxt.trim());
  await page.screenshot({ path: `${OUT}/save-toast.png` });

  check('No console errors (real-data pass)', consoleErrors.length === 0, consoleErrors.join(' | '));
  await ctx.close();

  // ── New-account simulation via API stubbing: empty states ───────────────────
  const ectx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  await ectx.request.post(`${BASE}/api/auth/login`, { data: CRED });
  const ep = await ectx.newPage();
  const emptyErrors = [];
  ep.on('console', m => { if (m.type() === 'error') emptyErrors.push(m.text()); });
  ep.on('pageerror', e => emptyErrors.push('pageerror: ' + e.message));

  // Stub the endpoints that make the account look brand-new.
  await ep.route('**/api/user/voice-profile', r => r.fulfill({ json: { profile: {}, defaults: { formality: 'balanced', contraction_style: 'sometimes', opener_style: 'direct', sentence_rhythm: 'mixed' } } }));
  await ep.route('**/api/user/context', r => r.fulfill({ json: { exists: false, context: {} } }));
  await ep.route('**/api/competitors', r => r.fulfill({ json: [] }));
  await ep.route('**/api/changes?**', r => r.fulfill({ json: { changes: [] } }));
  await ep.route('**/api/changes/stats', r => r.fulfill({ json: { total_competitors: 0, active_competitors: 0, total_changes: 0, changes_this_week: 0, high_threats: 0, medium_threats: 0 } }));

  // Voice empty state
  await settle(ep, '#/profile/voice', '#profile-panel');
  const vEmpty = await ep.textContent('#profile-panel');
  check('Voice empty: usage line present', vEmpty.includes('Used to draft outreach messages that sound like you.'));
  check('Voice empty: example present', /Example:.*Cheers, Sam/.test(vEmpty));
  await ep.screenshot({ path: `${OUT}/empty-voice.png` });

  // Business context empty -> placeholders visible
  await settle(ep, '#/settings/workspace', '#ctx-what-we-sell');
  const ws = await ep.inputValue('#ctx-what-we-sell');
  check('Workspace fields empty for new user (placeholder visible)', ws === '');
  await ep.screenshot({ path: `${OUT}/empty-business-context.png` });

  // Empty dashboard
  await settle(ep, '#/', '.empty-state, .hero-stats');
  const dashText = await ep.textContent('#page-root');
  check('Empty dashboard guidance line present', dashText.includes('Add your first competitor to start receiving AI briefs.'));
  await ep.screenshot({ path: `${OUT}/empty-dashboard.png`, fullPage: true });

  check('No console errors (empty-state pass)', emptyErrors.length === 0, emptyErrors.join(' | '));

  // ── 375px mobile: Profile + Settings clean ──────────────────────────────────
  await ep.setViewportSize({ width: 375, height: 1400 });
  await settle(ep, '#/profile/security', '#profile-panel .set-card');
  let of1 = await ep.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('375px Profile: no horizontal overflow', !of1);
  await ep.screenshot({ path: `${OUT}/profile-375.png`, fullPage: true });
  await settle(ep, '#/settings/workspace', '#settings-panel .set-card');
  let of2 = await ep.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('375px Settings: no horizontal overflow', !of2);
  await ep.screenshot({ path: `${OUT}/settings-375.png`, fullPage: true });

  await browser.close();
  const passed = results.filter(r => r.p).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
