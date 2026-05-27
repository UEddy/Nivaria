// Unit tests for correlationEngine.classifyChangeTypes — the pattern_tag /
// gate_category / key_changes → pattern-type mapping that drives the ROI
// dashboard. Pure function, no DB, no AI, so these run in milliseconds.
//
// Guards the Phase 9 fix: a pricing/packaging move must never be bucketed as a
// "feature launch". The two regression cases that motivated this file:
//   • plan_restructure must map to pricing, NOT feature.
//   • a legacy untagged pricing change whose analysis happens to list a
//     "features" key_change must stay pricing-only (this was surfacing a bogus
//     "feature launch correlated with losses" card worth $223K on the demo).

const { classifyChangeTypes, PATTERN_TYPES, TYPE_LABEL } = require('./src/correlationEngine');

let pass = 0, fail = 0;
const failures = [];

// Build a fake change row. tags → JSON pattern_tags; kc → analysis.key_changes
// category list; gate → gate_category.
function row({ tags = null, kc = null, gate = null } = {}) {
  return {
    pattern_tags: tags ? JSON.stringify(tags) : null,
    gate_category: gate,
    analysis: kc ? JSON.stringify({ key_changes: kc.map(c => ({ category: c })) }) : null,
  };
}

// Assert the classified Set exactly equals the expected list (order-independent).
function eq(name, input, expected) {
  const got = [...classifyChangeTypes(input)].sort();
  const want = [...expected].sort();
  const ok = got.length === want.length && got.every((v, i) => v === want[i]);
  if (ok) { pass++; console.log(`  ✓ ${name} => {${got.join(', ') || '∅'}}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name} => got {${got.join(', ')}}, want {${want.join(', ')}}`); }
}

console.log('\n── pattern_tag → pricing ──');
eq('pricing_change',   row({ tags: ['pricing_change'] }),   ['pricing']);
eq('plan_restructure (NOT feature)', row({ tags: ['plan_restructure'] }), ['pricing']);
eq('tier_change',      row({ tags: ['tier_change'] }),      ['pricing']);
eq('pricing_* prefix', row({ tags: ['pricing_promo_launch'] }), ['pricing']);

console.log('\n── pattern_tag → feature (launch only) ──');
eq('feature_launch',    row({ tags: ['feature_launch'] }),    ['feature']);
eq('new_feature',       row({ tags: ['new_feature'] }),       ['feature']);
eq('capability_added',  row({ tags: ['capability_added'] }),  ['feature']);
eq('product_launch',    row({ tags: ['product_launch'] }),    ['feature']);

console.log('\n── pattern_tag → messaging ──');
eq('messaging_shift',   row({ tags: ['messaging_shift'] }),   ['messaging']);
eq('positioning_pivot', row({ tags: ['positioning_pivot'] }), ['messaging']);
eq('copy_change',       row({ tags: ['copy_change'] }),       ['messaging']);
eq('headings_changed (as tag)', row({ tags: ['headings_changed'] }), ['messaging']);

console.log('\n── pattern_tag → removed (NEVER feature) ──');
eq('removed_feature', row({ tags: ['removed_feature'] }), ['removed']);
eq('feature_removed', row({ tags: ['feature_removed'] }), ['removed']);
eq('deprecation',     row({ tags: ['deprecation'] }),     ['removed']);
eq('feature_removal (legacy)', row({ tags: ['feature_removal'] }), ['removed']);

console.log('\n── gate_category fallback ──');
eq('gate=pricing_pattern', row({ gate: 'pricing_pattern' }), ['pricing']);
eq('gate=headings_changed is NOT messaging', row({ gate: 'headings_changed' }), []);

console.log('\n── key_changes fallback (legacy rows, no tags) ──');
eq('kc pricing',   row({ kc: ['pricing'] }),   ['pricing']);
eq('kc messaging', row({ kc: ['messaging'] }), ['messaging']);
eq('kc positioning', row({ kc: ['positioning'] }), ['messaging']);
// THE BUG: a pricing-dominated legacy change with a stray "features" line item
// must NOT become a feature launch.
eq('kc [pricing,pricing,features] stays pricing-only', row({ kc: ['pricing', 'pricing', 'features'] }), ['pricing']);
eq('kc bare features does NOT imply launch', row({ kc: ['features'] }), []);

console.log('\n── multi-signal & demo shapes ──');
eq('pricing_change + feature_launch', row({ tags: ['pricing_change', 'feature_launch'] }), ['pricing', 'feature']);
// Demo change #13 shape: tag plan_restructure + gate headings_changed + kc pricing.
eq('demo "removed seat caps" => pricing only',
   row({ tags: ['plan_restructure'], gate: 'headings_changed', kc: ['pricing'] }), ['pricing']);
// Demo change #1 shape: untagged 30% price cut, kc lists a features line.
eq('demo "slashed pricing 30%" => pricing only',
   row({ kc: ['pricing', 'pricing', 'features'] }), ['pricing']);

console.log('\n── robustness (no crash on junk) ──');
eq('null everything', row({}), []);
eq('malformed tags JSON', { pattern_tags: '{not json', gate_category: null, analysis: null }, []);
eq('tags not an array', { pattern_tags: '"pricing_change"', gate_category: null, analysis: null }, []);
eq('unknown tag', row({ tags: ['totally_unknown_tag'] }), []);

console.log('\n── exported maps are complete ──');
function has(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` = ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name} missing`); }
}
for (const k of ['pricing', 'messaging', 'feature', 'removed']) {
  has(`PATTERN_TYPES.${k}`, !!PATTERN_TYPES[k], PATTERN_TYPES[k]);
  has(`TYPE_LABEL.${k}`,    !!TYPE_LABEL[k],    `"${TYPE_LABEL[k]}"`);
}

console.log(`\n══════════ classifyChangeTypes: ${pass} passed, ${fail} failed ══════════`);
if (fail) console.log('Failed:', failures.join(', '));
process.exit(fail === 0 ? 0 : 1);
