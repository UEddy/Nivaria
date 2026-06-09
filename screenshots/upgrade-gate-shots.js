// Screenshots of the tier-aware upgrade-gate modal in all four states.
//
// Renders the REAL modal: serves public/ (so /css/styles.css + /js/billing.js
// load unchanged) plus a tiny harness page that provides the same modal scaffold
// app/index.html uses, minimal esc/openModal stubs, then calls the real
// showUpgradeModal() with App.subscription.effectiveTier set per tier.
//
// Output: screenshots/upgrade-gate/<tier>-{desktop,mobile}.png

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PUBLIC = path.join(__dirname, '..', 'public');
const OUT = path.join(__dirname, 'upgrade-gate');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html' };

// Harness page: real modal scaffold + real CSS + real billing.js, with the
// handful of globals billing.js leans on (esc, openModal/closeModal, App).
const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/styles.css">
<style>body{background:#0A0A0A;margin:0;min-height:100vh}</style>
</head><body>
  <div class="modal-overlay" id="modal-overlay"><div class="modal" id="modal-box" role="dialog" aria-modal="true"><div id="modal-content"></div></div></div>
  <script>
    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
    function openModal(html){document.getElementById('modal-content').innerHTML=html;var b=document.getElementById('modal-box');b.style.maxWidth='540px';document.getElementById('modal-overlay').classList.add('open');}
    function closeModal(){}
    var App={subscription:null,user:{email:'user@example.com'}};
    window.App=App;
  </script>
  <script src="/js/billing.js"></script>
  <script>
    window.renderTier=function(t){App.subscription=t?{effectiveTier:t}:null;showUpgradeModal({error:'upgrade_required',message:"You've reached your plan's competitor limit. Upgrade to Pro to track more."});};
  </script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/harness') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HARNESS);
  }
  const file = path.join(PUBLIC, url);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const TIERS = ['free', 'pro', 'team', 'business'];

(async () => {
  await new Promise(r => server.listen(4555, r));
  const browser = await chromium.launch();
  for (const view of [{ name: 'desktop', w: 1200, h: 860 }, { name: 'mobile', w: 375, h: 812 }]) {
    const page = await browser.newPage({ viewport: { width: view.w, height: view.h } });
    await page.goto('http://localhost:4555/harness');
    // Warm-up: open the overlay once and let its opacity transition finish, so
    // the first captured tier isn't caught mid-fade.
    await page.evaluate(() => window.renderTier('free'));
    await page.waitForTimeout(500);
    for (const tier of TIERS) {
      await page.evaluate((t) => window.renderTier(t), tier);
      await page.waitForTimeout(300);
      const out = path.join(OUT, `${tier}-${view.name}.png`);
      await page.screenshot({ path: out });
      console.log('  ✓ ' + path.relative(path.join(__dirname, '..'), out));
    }
    await page.close();
  }
  await browser.close();
  server.close();
  console.log('\nDone — screenshots in screenshots/upgrade-gate/');
})().catch(e => { console.error(e); process.exit(1); });
