// Gate-modal screenshot as the FREE throwaway (reuses its session cookie).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';

(async () => {
  const tw = JSON.parse(fs.readFileSync(path.join(__dirname, '.throwaway.json'), 'utf8'));
  const cookieVal = tw.cookie.split('=').slice(1).join('=');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.addCookies([{ name: 'cs.sid', value: cookieVal, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app#/competitors`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(800);
  // Trigger a real 402 (free workspace already at its 1-competitor limit) → central gate modal.
  await page.evaluate(() => window.API.addCompetitor({ name: 'GateShot', url: 'https://gateshot.example.com' }).catch(() => {}));
  await page.waitForSelector('.modal-title:has-text("Upgrade to Pro")', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  const shown = await page.locator('.modal-title:has-text("Upgrade to Pro")').count();
  await page.screenshot({ path: path.join(__dirname, 'phase10', 'test5-gate-modal-free.png') });
  console.log('gate modal shown:', shown ? 'YES ✅' : 'NO ❌', '— saved test5-gate-modal-free.png');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
