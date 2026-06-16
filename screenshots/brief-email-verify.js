// Live verification for brief-email delivery.
//  1. Renders buildBriefHtml and checks: no em/en dash, no connector-plus, brief
//     content present, link present.
//  2. Performs a REAL Resend send via sendBriefEmail and prints the Resend id
//     (acceptance/delivery proof). Sender comes from RESEND_FROM (set below to
//     the verified noreply@nivaria.app).
//  3. Writes the rendered HTML to disk so it can be screenshotted by Playwright.
//
// Run: node screenshots/brief-email-verify.js  (loads .env for RESEND_API_KEY)

// Force the verified production sender for this run, BEFORE requiring ./email
// (FROM is resolved at module load).
process.env.RESEND_FROM = process.env.RESEND_FROM || 'Nivaria <noreply@nivaria.app>';
require('dotenv').config();
process.env.RESEND_FROM = 'Nivaria <noreply@nivaria.app>';
process.env.APP_URL = process.env.APP_URL || 'https://nivaria.app';

const path = require('path');
const fs = require('fs');
const { sendBriefEmail, buildBriefHtml } = require('../src/email');

const TO = process.argv[2] || 'eddyhamezz@gmail.com';
const OUT = path.join(__dirname, 'brief-email');
fs.mkdirSync(OUT, { recursive: true });

const competitor = { name: 'Acme Analytics', url: 'https://acme.example/pricing' };
const analysis = {
  threat_level: 'high',
  headline: 'Acme launched a usage-based pricing tier undercutting your mid-market plan',
  summary: 'Acme replaced its flat $99 Team plan with a usage-based tier starting at $39, and now advertises a 14-day trial with no card required. The pricing page reframes their value around per-seat flexibility aimed squarely at growing teams.',
  recommended_response: 'Lead with total cost of ownership at scale and your predictable flat pricing. Prepare a side-by-side for deals where the buyer is comparing per-seat math against a fixed annual number.',
  talking_points: [
    'Their entry price looks lower, but usage-based billing gets unpredictable past 20 seats.',
    'Highlight your included onboarding and the fact that there is no metered overage.',
    'Trial-to-paid friction: ask where their no-card trial leaves the buyer after 14 days.',
  ],
};
const changeId = 4242;

(async () => {
  const html = buildBriefHtml(competitor, analysis, changeId);
  fs.writeFileSync(path.join(OUT, 'brief-email.html'), html, 'utf8');

  const checks = [];
  const ok = (c, m) => checks.push(`${c ? 'PASS' : 'FAIL'} ${m}`);
  // Dash audit: forbid em-dash (U+2014) and en-dash (U+2013). Hyphen-minus is fine.
  ok(!/[—–]/.test(html), 'no em/en dash in email HTML');
  // Connector-plus: a "+" with whitespace on both sides between words.
  ok(!/\w\s\+\s\w/.test(html), 'no connector-plus in email HTML');
  ok(html.includes('Acme Analytics'), 'competitor name present');
  ok(html.includes('usage-based pricing tier'), 'headline (what changed) present');
  ok(html.includes('total cost of ownership'), 'recommended response present');
  ok(html.includes('unpredictable past 20 seats'), 'talking points present');
  ok(html.includes(`/app#/history/${changeId}`), 'view-brief link present');
  ok(/HIGH THREAT/.test(html), 'threat badge present');

  console.log('\n=== RENDER CHECKS ===');
  checks.forEach(c => console.log(c));

  console.log('\n=== LIVE RESEND SEND ===');
  console.log(`from: Nivaria <noreply@nivaria.app>  ->  to: ${TO}`);
  const res = await sendBriefEmail(TO, { competitor, analysis, changeId });
  console.log('result:', JSON.stringify(res));
  if (res.delivered && res.data?.id) {
    console.log(`DELIVERED. Resend email id = ${res.data.id}`);
  } else {
    console.log('NOT DELIVERED. See [EMAIL_DELIVERY_FAILED] above.');
  }

  const renderPass = checks.every(c => c.startsWith('PASS'));
  console.log(`\nOVERALL render=${renderPass ? 'PASS' : 'FAIL'} delivered=${!!res.delivered}`);
  process.exit(renderPass && res.delivered ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
