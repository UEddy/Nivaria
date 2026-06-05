// Screenshot the "Delete account" confirmation modal (password re-entry).
// Opens it only — never submits. Uses demo (pro) via API login.
const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@nivaria.app', password: 'Demo1234!' } });
  if (!login.ok()) { console.error('login failed', login.status()); process.exit(1); }
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app#/settings`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Delete account")');
  await page.waitForSelector('#del-pw', { timeout: 5000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, 'phase10', 'test11-delete-modal.png') });
  console.log('delete-account modal shown:', await page.locator('#del-pw').count() ? 'YES ✅' : 'NO ❌');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
