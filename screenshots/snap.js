// Reusable: log in as a user, navigate to a hash route, screenshot.
// Usage: node screenshots/snap.js <hashRoute> <outName> [email] [password] [width]
const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://localhost:3000';

(async () => {
  const [, , hash, name, email = 'demo@competitor-shadow.com', password = 'Demo1234!', width = '1440'] = process.argv;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: parseInt(width, 10), height: 950 } });
  const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email, password } });
  if (!login.ok()) { console.error('login failed', login.status()); process.exit(1); }
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app#/${hash}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(__dirname, 'phase10', name + '.png'), fullPage: true });
  console.log('saved', name + '.png');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
