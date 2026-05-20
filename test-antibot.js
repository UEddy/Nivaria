// Probe anti-bot / SPA behavior
const { fetchPageContent } = require('./src/scraper');

const TARGETS = [
  'https://www.amazon.com/',
  'https://www.notion.com/pricing',
  'https://www.g2.com/products/notion/reviews',
  'https://www.linkedin.com/company/anthropic',
  'https://www.cloudflare.com/',
];

(async () => {
  for (const url of TARGETS) {
    console.log(`\n=== ${url} ===`);
    try {
      const r = await fetchPageContent(url);
      const c = r.content;
      console.log('title       :', c.title);
      console.log('headings #  :', c.headings.length, '  first:', c.headings.slice(0, 5));
      console.log('bodyText len:', c.bodyText.length);
      console.log('body sample :', c.bodyText.slice(0, 400).replace(/\s+/g, ' '));
    } catch (e) {
      console.log('ERROR:', e.message);
      if (e.response) {
        console.log('  status:', e.response.status);
        console.log('  body  :', String(e.response.data).slice(0, 300));
      }
    }
  }
})();
