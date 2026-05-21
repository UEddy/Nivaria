// Phase 4 — live AI calibration.
//
// Sends 5 hand-crafted competitor-change diffs to the real Anthropic API
// and prints the analyzer's threat-level assessment for human inspection.
// Requires ANTHROPIC_API_KEY in the environment.
//
// What we're checking by eye:
//   • Are LOW changes (copy refresh, year rollover) classified LOW?
//   • Are MEDIUM changes (new feature, repositioning) classified MEDIUM?
//   • Are HIGH changes (pricing change, new tier) classified HIGH?
//   • Does is_meaningful=false fire for genuinely trivial changes that
//     somehow slipped past the gate?

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { analyzeChange, estimateCostUsd } = require('./src/analyzer');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY not set. Add it to .env and re-run.');
  process.exit(1);
}

const competitor = {
  name: 'Acme Corp',
  url: 'https://acmecorp.com/pricing',
  description: 'Primary competitor — overlapping mid-market SaaS positioning',
};

const cases = [
  {
    label: 'LOW: copyright year rollover (this should also probably be flagged is_meaningful=false)',
    expected: 'low',
    before: { title: 'Acme — Pricing', metaDescription: 'Plans for every team', headings: ['Plans', 'FAQ'], pricing: 'Pro $49/mo', features: '', bodyText: 'Acme helps teams ship faster. Copyright 2025 Acme Inc.' },
    after:  { title: 'Acme — Pricing', metaDescription: 'Plans for every team', headings: ['Plans', 'FAQ'], pricing: 'Pro $49/mo', features: '', bodyText: 'Acme helps teams ship faster. Copyright 2026 Acme Inc.' },
  },
  {
    label: 'LOW: a new customer testimonial was added',
    expected: 'low',
    before: { title: 'Acme', metaDescription: 'Acme helps teams', headings: ['Why Acme', 'Customers', 'Pricing'], pricing: 'Pro $49/mo, Team $99/mo, Enterprise contact us', features: 'Dashboards, integrations, audit logs', bodyText: 'Trusted by 1200 teams. "Acme transformed our workflow" — Sarah, Director of Ops at Globex. View pricing and start a trial today.' },
    after:  { title: 'Acme', metaDescription: 'Acme helps teams', headings: ['Why Acme', 'Customers', 'Pricing'], pricing: 'Pro $49/mo, Team $99/mo, Enterprise contact us', features: 'Dashboards, integrations, audit logs', bodyText: 'Trusted by 1200 teams. "Acme transformed our workflow" — Sarah, Director of Ops at Globex. "We cut reporting time by 70%" — Marcus, VP Engineering at InitTech. View pricing and start a trial today.' },
  },
  {
    label: 'MEDIUM: new feature added to the feature list (no pricing change)',
    expected: 'medium',
    before: { title: 'Acme — Features', metaDescription: 'Acme features', headings: ['Dashboards', 'Integrations', 'Audit Logs'], pricing: 'Pro $49/mo', features: 'Real-time dashboards. 150+ integrations with Slack, Notion, Linear. SOC2-compliant audit logs.', bodyText: 'Acme provides real-time dashboards, 150+ integrations, and audit logs for compliance.' },
    after:  { title: 'Acme — Features', metaDescription: 'Acme features', headings: ['Dashboards', 'Integrations', 'Audit Logs', 'AI Assistant'], pricing: 'Pro $49/mo', features: 'Real-time dashboards. 150+ integrations with Slack, Notion, Linear. SOC2-compliant audit logs. NEW: AI Assistant for summarizing data and generating reports.', bodyText: 'Acme provides real-time dashboards, 150+ integrations, audit logs, and now an AI Assistant that summarizes data and writes reports for you.' },
  },
  {
    label: 'HIGH: aggressive pricing cut on the Pro plan',
    expected: 'high',
    before: { title: 'Acme — Pricing', metaDescription: 'Plans for every team', headings: ['Starter', 'Pro', 'Team', 'Enterprise'], pricing: 'Starter Free. Pro $49 per seat per month. Team $99 per seat per month. Enterprise contact us.', features: 'All plans include dashboards and integrations.', bodyText: 'Pricing: Starter is Free. Pro is $49 per seat per month with unlimited dashboards. Team is $99 per seat per month with audit logs. Enterprise pricing on request.' },
    after:  { title: 'Acme — Pricing', metaDescription: 'Plans for every team', headings: ['Starter', 'Pro', 'Team', 'Enterprise'], pricing: 'Starter Free. Pro $29 per seat per month. Team $79 per seat per month. Enterprise contact us.', features: 'All plans include dashboards and integrations.', bodyText: 'Pricing: Starter is Free. Pro is $29 per seat per month with unlimited dashboards. Team is $79 per seat per month with audit logs. Enterprise pricing on request.' },
  },
  {
    label: 'HIGH: brand new product tier launched ($9 Starter that didn\'t exist)',
    expected: 'high',
    before: { title: 'Acme — Pricing', metaDescription: 'Acme plans', headings: ['Pro', 'Team', 'Enterprise'], pricing: 'Pro $49/mo. Team $99/mo. Enterprise contact us.', features: 'All plans include dashboards and integrations.', bodyText: 'Choose Pro at $49/mo, Team at $99/mo, or Enterprise for custom pricing. All plans include dashboards.' },
    after:  { title: 'Acme — Pricing', metaDescription: 'Acme plans', headings: ['Starter', 'Pro', 'Team', 'Enterprise'], pricing: 'NEW Starter $9/mo. Pro $49/mo. Team $99/mo. Enterprise contact us.', features: 'All plans include dashboards and integrations.', bodyText: 'New: Starter at $9/mo for solo users. Pro at $49/mo, Team at $99/mo, Enterprise for custom pricing. All plans include dashboards.' },
  },
];

function generateDiff(before, after) {
  return {
    isFirstCheck: false,
    added: [],
    removed: [],
    beforeHeadings: before.headings,
    afterHeadings: after.headings,
    beforePricing: before.pricing,
    afterPricing: after.pricing,
    beforeFeatures: before.features,
    afterFeatures: after.features,
    beforeTitle: before.title,
    afterTitle: after.title,
    beforeMeta: before.metaDescription,
    afterMeta: after.metaDescription,
  };
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Phase 4 — live AI calibration (real Anthropic calls)');
  console.log('══════════════════════════════════════════════════════════');

  let totalCost = 0;
  let totalIn   = 0;
  let totalOut  = 0;
  const summary = [];

  for (const [i, tc] of cases.entries()) {
    console.log(`\n[${i + 1}/${cases.length}] ${tc.label}`);
    console.log(`     expected: ${tc.expected}`);
    const diff = generateDiff(tc.before, tc.after);
    try {
      const { analysis, usage } = await analyzeChange(competitor, tc.before, tc.after, diff);
      const cost = estimateCostUsd(usage);
      totalCost += cost;
      totalIn  += usage?.input_tokens  || 0;
      totalOut += usage?.output_tokens || 0;
      const verdict = analysis.threat_level === tc.expected ? '✅' : '⚠️ ';
      console.log(`     AI says:  threat=${analysis.threat_level}, is_meaningful=${analysis.is_meaningful} ${verdict}`);
      console.log(`     headline: "${analysis.headline}"`);
      console.log(`     changed_what:  ${analysis.changed_what}`);
      console.log(`     why_it_matters: ${analysis.why_it_matters}`);
      console.log(`     reasoning: ${analysis.threat_reasoning}`);
      console.log(`     action:    ${analysis.recommended_response}`);
      console.log(`     tokens: in=${usage?.input_tokens || 0} out=${usage?.output_tokens || 0} ≈$${cost.toFixed(4)}`);
      summary.push({ label: tc.label, expected: tc.expected, got: analysis.threat_level, meaningful: analysis.is_meaningful, match: analysis.threat_level === tc.expected });
    } catch (err) {
      console.error(`     ❌ AI call failed: ${err.code || err.name}: ${err.message}`);
      summary.push({ label: tc.label, expected: tc.expected, got: 'ERROR', meaningful: null, match: false, error: err.message });
    }
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Calibration summary');
  console.log('══════════════════════════════════════════════════════════');
  for (const s of summary) {
    const mark = s.match ? '✅' : '⚠️ ';
    console.log(`  ${mark} expected=${s.expected.padEnd(6)} got=${String(s.got).padEnd(6)} meaningful=${s.meaningful} | ${s.label}`);
  }
  const matches = summary.filter(s => s.match).length;
  console.log(`\n  ${matches}/${summary.length} threat levels matched expectation`);
  console.log(`  Total: input=${totalIn} tokens, output=${totalOut} tokens, est cost=$${totalCost.toFixed(4)}`);
  console.log('  (Manual judgment required: review the reasoning and headlines above.)\n');
})().catch(e => { console.error('Calibration harness crashed:', e); process.exit(1); });
