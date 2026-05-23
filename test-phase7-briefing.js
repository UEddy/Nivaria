// Phase 7 — Haiku condensation + payload-shape smoke test.
//
// What it tests:
//   • Real Anthropic Haiku call: condenses a verbose battle-card's
//     talking_points into 2-3 pre-meeting one-liners, prints usage + cost
//   • Slack payload block shape (header + sections + battle-card link)
//   • Discord embed shape (title, color by threat_level, embed.url to card)
//   • Empty-change variant — verifies the "no material changes" copy path
//
// How to run (server irrelevant — no DB writes, only Anthropic + in-memory
// payload assembly):
//   node test-phase7-briefing.js
//
// Prerequisites:
//   • ANTHROPIC_API_KEY in .env with non-zero balance
//   • No webhook URL needed — payloads are inspected, not POSTed

require('dotenv').config();
process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ||= require('crypto').randomBytes(32).toString('hex');

const {
  condenseTalkingPoints,
  formatSlackPayload,
  formatDiscordPayload,
  estimateHaikuCostUsd,
} = require('./src/briefingDispatch');

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else      { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}

(async () => {
  console.log('\n── Haiku condensation (real API call) ──');
  const condensed = await condenseTalkingPoints({
    competitorName: 'BambooHR',
    meetingTitle:   'Renewal call with NorthWind Industries (BambooHR incumbent)',
    headline:       'BambooHR overhauls pricing: 3 tiers, 52% base price hike, new enterprise tier with dedicated implementation',
    summary:        'BambooHR restructured from 2 tiers ($5.25/$8.75) to 3 ($8/$12/$18) with seat minimums and mandatory annual billing on Pro and Advantage. Their new Advantage tier bundles dedicated implementation, SSO/SAML, and premium SLA.',
    talkingPoints: [
      "BambooHR's entry price just jumped 52% — from $5.25 to $8.00/employee/month. Helix delivers more value without forcing you up-tier.",
      "BambooHR locks dedicated implementation behind their $18/employee Advantage tier with a 50-seat minimum. With Helix, implementation support is standard for every customer.",
      "BambooHR's payroll story is still partner integrations — bolt-ons, not a unified system. Helix is built payroll-first so HR and payroll share the same data with no sync errors.",
      "BambooHR now requires annual billing on Pro and Advantage tiers with seat minimums — less flexibility as your team scales. Helix's pricing is designed for mid-market realities.",
    ],
  });

  assert('returned an array of talking points', Array.isArray(condensed.talkingPoints));
  assert('between 2 and 3 talking points',      condensed.talkingPoints.length >= 2 && condensed.talkingPoints.length <= 3, `got ${condensed.talkingPoints.length}`);
  assert('source is haiku',                      condensed.source === 'haiku', `got ${condensed.source}`);
  assert('usage tokens reported',                condensed.usage && condensed.usage.input_tokens > 0 && condensed.usage.output_tokens > 0);
  const cost = estimateHaikuCostUsd(condensed.usage);
  console.log(`     in=${condensed.usage.input_tokens}  out=${condensed.usage.output_tokens}  cost ≈ $${cost.toFixed(5)}`);
  console.log(`     points: ${JSON.stringify(condensed.talkingPoints, null, 2).split('\n').join('\n     ')}`);

  console.log('\n── Slack + Discord payload shapes ──');
  const args = {
    competitor: { id: 1, name: 'BambooHR', url: 'https://www.bamboohr.com' },
    meeting:    { id: 99, title: 'NorthWind renewal', start_time: new Date(Date.now() + 30*60*1000).toISOString() },
    change:     {
      id: 7, headline: 'Pricing restructure', threat_level: 'high',
      detected_at: '2026-05-23 10:00:00', analysis: '{}', talking_points: '[]',
    },
    points: condensed.talkingPoints,
    matchReason: 'domain',
    appUrl: 'http://localhost:3000',
  };
  const slack = formatSlackPayload(args);
  const discord = formatDiscordPayload(args);

  assert('slack payload has blocks',           Array.isArray(slack.blocks) && slack.blocks.length >= 4);
  assert('slack header is a header block',     slack.blocks[0]?.type === 'header');
  assert('discord payload has embeds',         Array.isArray(discord.embeds) && discord.embeds.length === 1);
  assert('discord embed mentions competitor',  /BambooHR/.test(discord.embeds[0].title));
  assert('discord embed links to battle card', String(discord.embeds[0].url || '').includes('/history/7'));

  console.log('\n── Empty-change variant (Test 5 shape) ──');
  const empty = formatSlackPayload({ ...args, change: null });
  assert('empty change still produces blocks', Array.isArray(empty.blocks) && empty.blocks.length >= 2);
  const text = JSON.stringify(empty);
  assert('empty briefing mentions "no material"', /no material/i.test(text));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('Runner crashed:', e); process.exit(1); });
