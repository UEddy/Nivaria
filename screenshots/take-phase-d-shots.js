// Phase D verification — capture the Competitors page at 4 widths and report
// small-touch / overflow / vw / table-overflow on each. Confirms the mobile
// card-stack renders, the desktop table is untouched, and the 768px boundary
// switches cleanly.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'phase-d');
fs.mkdirSync(OUT, { recursive: true });

function pageAudit() {
  const vw = window.innerWidth;
  const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const small = [];
  const seen = new Set();
  const sel = 'a, button, input:not([type=hidden]), select, textarea, [role="button"], [onclick], .nav-item, .deals-tab, .outcome-btn, .modal-close, .set-linkbtn, .link-btn';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) continue;
    if (r.width === 0 || r.height === 0) continue;
    if (r.width < 44 || r.height < 44) {
      const d = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
      const k = d + Math.round(r.width) + 'x' + Math.round(r.height);
      if (seen.has(k)) continue; seen.add(k);
      small.push({ sel: d, w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  const tables = Array.from(document.querySelectorAll('table'));
  const tableOverflow = tables.filter(t => t.scrollWidth > vw + 1).length;
  return {
    vw, docW, overflowX: docW - vw,
    tableVisible: !!document.querySelector('.competitors-table-view') && getComputedStyle(document.querySelector('.competitors-table-view')).display !== 'none',
    cardViewVisible: !!document.querySelector('.competitors-card-view') && getComputedStyle(document.querySelector('.competitors-card-view')).display !== 'none',
    cardCount: document.querySelectorAll('.comp-card').length,
    kebabSize: (() => {
      const k = document.querySelector('.comp-card-kebab');
      if (!k) return null;
      const r = k.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    checkBtnSize: (() => {
      const b = document.querySelector('.comp-card-check');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    smallTouch: small.slice(0, 16),
    smallTouchCount: small.length,
    tableOverflow,
  };
}

(async () => {
  const browser = await chromium.launch();

  // Single login, share the cookie storage across every viewport context so we
  // don't hammer the login rate limiter (10 / 15min / IP).
  const seedCtx = await browser.newContext();
  const login = await seedCtx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@nivaria.app', password: 'Demo1234!' } });
  if (!login.ok()) throw new Error(`login seed: ${login.status()}`);
  const storageState = await seedCtx.storageState();
  await seedCtx.close();

  const widths = [
    { w: 375, h: 812, label: '375 (iPhone SE / 14)',     fname: '375', isMobile: true  },
    { w: 414, h: 896, label: '414 (iPhone Pro Max)',     fname: '414', isMobile: true  },
    { w: 768, h: 1024, label: '768 (tablet portrait)',   fname: '768', isMobile: true  },
    { w: 820, h: 1180, label: '820 (iPad)',              fname: '820', isMobile: true  },
    { w: 1024, h: 768, label: '1024 (small desktop)',    fname: '1024', isMobile: false },
    { w: 1440, h: 900, label: '1440 (standard desktop)', fname: '1440', isMobile: false },
  ];
  const results = {};
  for (const v of widths) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2, hasTouch: v.isMobile, isMobile: v.isMobile, storageState });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/app#/competitors`, { waitUntil: 'networkidle' });
    await p.waitForSelector('.competitors-table-view, .competitors-card-view', { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(1000);
    await p.screenshot({ path: path.join(OUT, `competitors-${v.fname}.png`), fullPage: true });
    const data = await p.evaluate(pageAudit);
    results[v.fname] = data;
    const layout = data.tableVisible && !data.cardViewVisible ? 'TABLE' : !data.tableVisible && data.cardViewVisible ? 'CARDS' : 'BOTH?';
    console.log(`  ${v.label.padEnd(28)}  vw=${String(data.vw).padStart(4)}  overflowX=${data.overflowX}  layout=${layout}  cards=${data.cardCount}  small-touch=${data.smallTouchCount}  table-overflow=${data.tableOverflow}`);
    if (data.kebabSize) console.log(`     kebab ${data.kebabSize.w}x${data.kebabSize.h}, check button ${data.checkBtnSize?.w}x${data.checkBtnSize?.h}`);
    await ctx.close();
  }
  fs.writeFileSync(path.join(__dirname, '..', 'phase-d-report.json'), JSON.stringify(results, null, 2));
  await browser.close();
  console.log('\nScreenshots:', OUT);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
