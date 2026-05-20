// Test the no-API-key fallback path of analyzer.js
process.env.ANTHROPIC_API_KEY = ''; // force fallback before requiring analyzer
const { analyzeChange } = require('./src/analyzer');

const competitor = { name: 'htmx (sim)', url: 'https://htmx.org/' };
const diff = {
  isFirstCheck: false,
  added: ['enterprise','month'],
  removed: [],
  beforeHeadings: ['introduction','motivation'],
  afterHeadings: ['Enterprise pricing now available','introduction','motivation'],
  beforePricing: '',
  afterPricing: 'Enterprise plan — $499 / month. Includes SSO, 24/7 support, 99.99% SLA.',
  beforeFeatures: '',
  afterFeatures: '',
  beforeTitle: '</> htmx - high power tools for html',
  afterTitle: '</> htmx - high power tools for html — NEW: Enterprise plan $499/mo',
};

(async () => {
  const r = await analyzeChange(competitor, null, null, diff);
  console.log('--- FALLBACK BATTLE CARD ---');
  console.log(JSON.stringify(r, null, 2));
})();
