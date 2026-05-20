// Honest end-to-end test of the real scraper + analyzer against live sites.
// Does not touch the production DB. Does not seed demo data.

require('dotenv').config();
const { fetchPageContent, generateDiff } = require('./src/scraper');
const { analyzeChange } = require('./src/analyzer');

const SITES = [
  { kind: 'static-marketing', name: 'htmx', url: 'https://htmx.org/' },
  { kind: 'saas-pricing-js',  name: 'Linear pricing', url: 'https://linear.app/pricing' },
  { kind: 'news-article',     name: 'Wikipedia: Web scraping', url: 'https://en.wikipedia.org/wiki/Web_scraping' },
];

function preview(s, n = 600) {
  if (!s) return '(empty)';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + ` …[+${s.length - n} more chars]` : s;
}

function summarize(label, result) {
  const c = result.content;
  console.log(`\n========== ${label} ==========`);
  console.log('URL              :', result.url);
  console.log('Hash             :', result.hash);
  console.log('title            :', preview(c.title, 200));
  console.log('metaDescription  :', preview(c.metaDescription, 200));
  console.log('ogTitle          :', preview(c.ogTitle, 200));
  console.log('headings (count) :', c.headings.length);
  console.log('headings (first8):', c.headings.slice(0, 8));
  console.log('pricing (len)    :', c.pricing.length, '— sample:', preview(c.pricing, 400));
  console.log('features (len)   :', c.features.length, '— sample:', preview(c.features, 400));
  console.log('bodyText (len)   :', c.bodyText.length);
  console.log('bodyText sample  :', preview(c.bodyText, 800));
}

(async () => {
  const baselines = {};

  // PART 2: baselines
  for (const site of SITES) {
    try {
      console.log(`\n>>> Fetching ${site.name} (${site.kind})`);
      const t0 = Date.now();
      const r = await fetchPageContent(site.url);
      const ms = Date.now() - t0;
      summarize(`${site.name}  [${site.kind}]  fetched in ${ms}ms`, r);
      baselines[site.name] = r;
    } catch (e) {
      console.log(`\n!!! FETCH FAILED: ${site.name} — ${e.message}`);
      if (e.response) {
        console.log(`    HTTP status: ${e.response.status}`);
        console.log(`    server      : ${e.response.headers?.server}`);
        console.log(`    body sample : ${String(e.response.data).slice(0, 400)}`);
      }
      baselines[site.name] = null;
    }
  }

  // PART 4: noise — fetch the static site twice and compare hashes
  console.log('\n\n========== PART 4: NOISE TEST ==========');
  const noiseTarget = SITES[0];
  const first  = baselines[noiseTarget.name];
  if (first) {
    await new Promise(r => setTimeout(r, 1500));
    const second = await fetchPageContent(noiseTarget.url);
    console.log(`Target: ${noiseTarget.name} (${noiseTarget.url})`);
    console.log(`Hash A: ${first.hash}`);
    console.log(`Hash B: ${second.hash}`);
    console.log(`Equal? ${first.hash === second.hash ? 'YES — no false positive' : 'NO — false positive!'}`);
    if (first.hash !== second.hash) {
      // Show where they differ
      const a = JSON.stringify(first.content);
      const b = JSON.stringify(second.content);
      for (const k of Object.keys(first.content)) {
        const av = JSON.stringify(first.content[k]);
        const bv = JSON.stringify(second.content[k]);
        if (av !== bv) {
          console.log(`  field "${k}" differs.`);
          console.log(`    A: ${preview(av, 400)}`);
          console.log(`    B: ${preview(bv, 400)}`);
        }
      }
    }
  } else {
    console.log('Skipped: first baseline failed.');
  }

  // Also fetch the SaaS pricing page twice — likeliest source of noise
  const noise2 = SITES[1];
  const f1 = baselines[noise2.name];
  if (f1) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const f2 = await fetchPageContent(noise2.url);
      console.log(`\nTarget: ${noise2.name} (${noise2.url})`);
      console.log(`Hash A: ${f1.hash}`);
      console.log(`Hash B: ${f2.hash}`);
      console.log(`Equal? ${f1.hash === f2.hash ? 'YES — no false positive' : 'NO — false positive!'}`);
      if (f1.hash !== f2.hash) {
        for (const k of Object.keys(f1.content)) {
          const av = JSON.stringify(f1.content[k]);
          const bv = JSON.stringify(f2.content[k]);
          if (av !== bv) {
            console.log(`  field "${k}" differs.`);
            console.log(`    A: ${preview(av, 400)}`);
            console.log(`    B: ${preview(bv, 400)}`);
          }
        }
      }
    } catch (e) {
      console.log(`  second fetch failed: ${e.message}`);
    }
  }

  // PART 3: simulated change + AI analysis
  console.log('\n\n========== PART 3: SIMULATED CHANGE ==========');
  const target = baselines['htmx'];
  if (target) {
    const before = JSON.parse(JSON.stringify(target.content));
    const after  = JSON.parse(JSON.stringify(target.content));

    // Inject a realistic competitor change: rewrite the title + insert a fake pricing line.
    after.title = (after.title || 'htmx') + ' — NEW: Enterprise plan $499/mo';
    after.metaDescription = 'htmx now offers an Enterprise plan with SSO, SLA, and priority support for $499/month.';
    after.headings = ['Enterprise pricing now available', ...after.headings].slice(0, 60);
    after.pricing = 'Enterprise plan — $499 / month. Includes SSO, 24/7 support, 99.99% SLA. ' + after.pricing;
    after.bodyText = ('Enterprise plan $499 per month with SSO and SLA. ' + after.bodyText).slice(0, 40000);

    const diff = generateDiff(before, after);
    console.log('Diff summary:');
    console.log('  title  :', diff.beforeTitle, '→', diff.afterTitle);
    console.log('  added words (first 30):', diff.added.slice(0, 30));
    console.log('  removed words (first 30):', diff.removed.slice(0, 30));
    console.log('  headings before[0..3]:', diff.beforeHeadings.slice(0, 3));
    console.log('  headings after[0..3] :', diff.afterHeadings.slice(0, 3));

    const fakeCompetitor = {
      name: 'htmx (simulated)',
      url: 'https://htmx.org/',
      description: 'A hypertext-driven UI library — main rival to our React-based product.',
    };
    console.log('\nCalling Anthropic analyzer (real API call)…');
    try {
      const analysis = await analyzeChange(fakeCompetitor, before, after, diff);
      console.log('\n--- BATTLE CARD ---');
      console.log(JSON.stringify(analysis, null, 2));
    } catch (e) {
      console.log('AI call FAILED:', e.message);
    }
  } else {
    console.log('Skipped: no htmx baseline.');
  }

  console.log('\n\n>>> done');
})().catch(e => { console.error(e); process.exit(1); });
