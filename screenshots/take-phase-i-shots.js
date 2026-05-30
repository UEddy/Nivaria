// Phase I verification — accessibility & touch.
//   1. 44px touch-target audit across interactive elements at 375/414/768/1024/1440
//   2. 8px adjacency audit on horizontal action-button pairs
//   3. WCAG AA contrast check on the muted text tokens over the off-black surfaces
//   4. Focus-visibility screenshots: drawer, modal, form
//   5. Desktop regression at 1440
//
// Usage: node screenshots/take-phase-i-shots.js   → screenshots/phase-i/ + report JSON
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, 'phase-i');
fs.mkdirSync(OUT, { recursive: true });

// The server caps the general API at 100 req / 15 min (in-memory). A full pass
// (audit loop + screenshots) exceeds that, so split into modes and restart the
// server between them: `node take-phase-i-shots.js audit` then `... shots`.
// Default `all` runs both (fine right after a server restart for a short run).
const MODE = process.argv[2] || 'all';
const REPORT_PATH = path.join(__dirname, '..', 'phase-i-report.json');

const FLOOR = 44;
const TOL = 0.5;              // sub-pixel tolerance
const ADJ_MIN = 8;

// Selectors treated as interactive for the touch audit.
const INTERACTIVE = [
  'button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea',
  '[role=tab]', '[role=button]', '[role=switch]', '.nav-item', '.theme-btn',
].join(',');

// Documented intentional exceptions — reported separately, not as violations.
// (selector match → reason)
const EXCEPTIONS = [
  { test: (m) => m.cls.includes('comp-card-url'), reason: 'URL text link; kebab is the row action (min-height:32 by design)' },
  { test: (m) => m.cls.includes('comp-card-name'), reason: 'inline heading link; wraps, height is line-driven' },
  { test: (m) => m.cls.includes('comp-meta-link'), reason: 'inline metadata text link (WCAG 2.5.8 inline exception)' },
  { test: (m) => m.cls.includes('bc-comp-url') || m.cls.includes('cd-url'), reason: 'inline URL text link in detail header' },
  { test: (m) => m.cls.includes('code-inline'), reason: 'non-interactive code chip' },
  { test: (m) => m.tag === 'a' && m.cls === '' , reason: 'inline prose link (inline exception)' },
];

function srgbToLin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrast(fg, bg) { const a = lum(fg), b = lum(bg); const hi = Math.max(a, b), lo = Math.min(a, b); return (hi + 0.05) / (lo + 0.05); }

(async () => {
  const browser = await chromium.launch();
  const seedCtx = await browser.newContext();
  const login = await seedCtx.request.post(`${BASE}/api/auth/login`, { data: { email: 'demo@competitor-shadow.com', password: 'Demo1234!' } });
  if (!login.ok()) throw new Error(`login: ${login.status()}`);
  const storageState = await seedCtx.storageState();
  await seedCtx.close();

  // Merge into any existing report so audit-mode and shots-mode runs coexist.
  let report = { generatedAt: new Date().toISOString(), touch: {}, adjacency: {}, contrast: {}, notes: [] };
  if (fs.existsSync(REPORT_PATH)) { try { report = { ...report, ...JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')) }; report.generatedAt = new Date().toISOString(); } catch (_) {} }
  const VIEWPORTS = [375, 414, 768, 1024, 1440];
  const PAGES = ['/app#/', '/app#/competitors', '/app#/deals', '/app#/settings', '/app#/history/13'];

  // ── 1 + 2. Touch + adjacency audit across viewports ───────────────────────
  for (const width of (MODE === 'shots' ? [] : VIEWPORTS)) {
    const isMobile = width < 1024;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, hasTouch: isMobile, isMobile, storageState });
    const p = await ctx.newPage();
    const violations = [];
    const exceptions = [];
    const adjacency = [];

    for (const route of PAGES) {
      try {
        await p.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 20000 });
        await p.waitForTimeout(700);
        // On the deals page, expand the log form so its fields/buttons are measured.
        if (route.endsWith('/deals')) {
          await p.evaluate(() => document.querySelector('.log-card-head .btn')?.click());
          await p.waitForTimeout(300);
        }

        const measured = await p.evaluate((sel) => {
          const out = [];
          document.querySelectorAll(sel).forEach(elm => {
            const style = getComputedStyle(elm);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            // Effective tap target: a checkbox/radio wrapped in (or associated
            // with) a <label> is activated by tapping the whole label, so the
            // label is the real target. Measure that instead of the 13px native
            // control. Same for any control wrapped in a clickable label.
            let target = elm;
            if (elm.tagName === 'INPUT' && (elm.type === 'checkbox' || elm.type === 'radio')) {
              const lab = elm.closest('label') ||
                (elm.id && document.querySelector(`label[for="${elm.id}"]`));
              if (lab) target = lab;
            }
            const r = target.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            out.push({
              tag: elm.tagName.toLowerCase(),
              cls: typeof elm.className === 'string' ? elm.className : '',
              w: +r.width.toFixed(1), h: +r.height.toFixed(1),
              via: target === elm ? 'self' : 'label',
              label: (elm.getAttribute('aria-label') || elm.textContent || target.textContent || '').trim().slice(0, 40),
            });
          });
          return out;
        }, INTERACTIVE);

        for (const m of measured) {
          if (m.w + TOL >= FLOOR && m.h + TOL >= FLOOR) continue;
          const exc = EXCEPTIONS.find(e => e.test(m));
          const rec = { route, ...m };
          if (exc) exceptions.push({ ...rec, reason: exc.reason });
          else violations.push(rec);
        }

        // Adjacency: horizontal gaps inside known action containers.
        const adj = await p.evaluate((min) => {
          const containers = ['.deal-row-actions', '.bc-headline-actions', '.outreach-actions', '.form-actions', '.modal-footer', '.deal-detail-actions', '.comp-card-actions'];
          const rows = [];
          containers.forEach(csel => {
            document.querySelectorAll(csel).forEach(c => {
              const kids = Array.from(c.children).filter(k => k.getBoundingClientRect().width > 0);
              for (let i = 1; i < kids.length; i++) {
                const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
                // Only horizontal neighbours (roughly same row).
                if (Math.abs(a.top - b.top) > 12) continue;
                const gap = +(b.left - a.right).toFixed(1);
                rows.push({ container: csel, gap, ok: gap + 0.5 >= min });
              }
            });
          });
          return rows;
        }, ADJ_MIN);
        adj.forEach(a => adjacency.push({ route, ...a }));
      } catch (e) {
        report.notes.push(`[${width}] ${route}: ${e.message.slice(0, 80)}`);
      }
    }

    report.touch[width] = { violations, exceptions: dedupe(exceptions) };
    report.adjacency[width] = { tooClose: adjacency.filter(a => !a.ok), checked: adjacency.length };
    await p.close(); await ctx.close();
  }

  // ── 3. Contrast on the off-black (dark) surfaces ──────────────────────────
  // Read the live token values from the rendered page so the report reflects
  // exactly what shipped, then compute ratios against the three dark surfaces.
  if (MODE !== 'shots') {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/app#/`, { waitUntil: 'networkidle' });
    const tok = await p.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const g = (n) => cs.getPropertyValue(n).trim();
      return { txt: g('--txt'), txt2: g('--txt-2'), txt3: g('--txt-3') };
    });
    const surfaces = { 'page #000': '#000000', 'card #0A0A0A': '#0A0A0A', 'elevated ~#101010': '#101010' };
    const toHex = (v) => v.startsWith('#') ? v : v; // tokens are hex
    for (const [name, sval] of Object.entries({ '--txt': tok.txt, '--txt-2': tok.txt2, '--txt-3': tok.txt3 })) {
      report.contrast[name] = { value: sval };
      for (const [sn, sv] of Object.entries(surfaces)) {
        report.contrast[name][sn] = +contrast(toHex(sval), sv).toFixed(2);
      }
    }
    await p.close(); await ctx.close();
  }

  // ── 4. Focus-visibility screenshots ───────────────────────────────────────
  // 4a. Drawer focused (375): open drawer, focus moves to first nav item.
  if (MODE !== 'audit') {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState });
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/app#/`, { waitUntil: 'networkidle', timeout: 20000 });
      await p.waitForTimeout(600);
      await p.evaluate(() => window.Drawer.open());
      await p.waitForTimeout(400);
      // Tab once to advance the visible focus ring to the second nav item so the
      // ring is unmistakable in the shot.
      await p.keyboard.press('Tab');
      await p.waitForTimeout(200);
      await p.screenshot({ path: path.join(OUT, 'focus-drawer-375.png') });
      console.log('  focus-drawer    375: ok');
    } catch (e) { console.log(`  x focus-drawer: ${e.message.slice(0,90)}`); }
    await p.close(); await ctx.close();
  }

  // 4b. Modal focused (375): open add-competitor modal, focus lands in first field.
  if (MODE !== 'audit') {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState });
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/app#/competitors`, { waitUntil: 'networkidle', timeout: 20000 });
      await p.waitForTimeout(700);
      await p.evaluate(() => window.Competitors?.showAddModal?.());
      await p.waitForTimeout(500);
      // Tab to the close button so the focus ring on the × is visible too.
      await p.keyboard.press('Tab');
      await p.waitForTimeout(150);
      await p.screenshot({ path: path.join(OUT, 'focus-modal-375.png') });
      console.log('  focus-modal     375: ok');
    } catch (e) { console.log(`  x focus-modal: ${e.message.slice(0,90)}`); }
    await p.close(); await ctx.close();
  }

  // 4c. Form focused (375): focus an input on the add-competitor form (keyboard ring).
  if (MODE !== 'audit') {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, storageState });
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/app#/competitors`, { waitUntil: 'networkidle', timeout: 20000 });
      await p.waitForTimeout(700);
      await p.evaluate(() => window.Competitors?.showAddModal?.());
      await p.waitForTimeout(500);
      await p.evaluate(() => document.getElementById('comp-url')?.focus());
      await p.waitForTimeout(200);
      await p.screenshot({ path: path.join(OUT, 'focus-form-375.png') });
      console.log('  focus-form      375: ok');
    } catch (e) { console.log(`  x focus-form: ${e.message.slice(0,90)}`); }
    await p.close(); await ctx.close();
  }

  // ── 5. Desktop regression at 1440 ─────────────────────────────────────────
  if (MODE !== 'audit') {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, storageState });
    const p = await ctx.newPage();
    for (const [route, name] of [['/app#/', 'dashboard'], ['/app#/deals', 'deals'], ['/app#/settings', 'settings']]) {
      try {
        await p.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 20000 });
        await p.waitForTimeout(900);
        await p.screenshot({ path: path.join(OUT, `desktop-${name}-1440.png`) });
        console.log(`  desktop-${name.padEnd(9)} 1440: ok`);
      } catch (e) { console.log(`  x desktop-${name}: ${e.message.slice(0,90)}`); }
    }
    await p.close(); await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(__dirname, '..', 'phase-i-report.json'), JSON.stringify(report, null, 2));

  // Console summary.
  console.log('\n── Phase I audit summary ──');
  for (const w of VIEWPORTS) {
    const t = report.touch[w], a = report.adjacency[w];
    console.log(`  ${w}px  touch-violations=${t.violations.length}  exceptions=${t.exceptions.length}  adjacency-tooClose=${a.tooClose.length}/${a.checked}`);
  }
  console.log('  contrast (dark):');
  for (const [k, v] of Object.entries(report.contrast)) {
    console.log(`    ${k} ${v.value}  card=${v['card #0A0A0A']}:1  elevated=${v['elevated ~#101010']}:1`);
  }
  if (report.notes.length) console.log('  notes:', report.notes);
  console.log(`\nScreenshots: ${OUT}\nReport: phase-i-report.json`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

function dedupe(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = x.cls + '|' + x.reason; if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}
