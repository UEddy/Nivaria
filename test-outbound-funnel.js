// Unit tests for src/outbound/funnel.js — the per-run rejection counters that
// make a zero-lead run diagnosable. Pure, no DB/network — run with
// `node test-outbound-funnel.js`.

const assert = require('assert');
const {
  makeFunnel, recordRejection, totalRejectedPeople, formatFunnel, REJECTION_REASONS,
} = require('./src/outbound/funnel');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  try { assert.strictEqual(actual, expected); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`); fail++; }
}
function ok(actual, label) {
  try { assert.ok(actual); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got: ${JSON.stringify(actual)}`); fail++; }
}

// ── fresh funnel is all zero, with a bucket per gate ──────────────────────────
const f = makeFunnel();
eq(f.discovered_raw, 0, 'fresh: discovered_raw 0');
eq(f.after_dedupe, 0, 'fresh: after_dedupe 0');
eq(f.no_person, 0, 'fresh: no_person 0');
eq(f.no_contact, 0, 'fresh: no_contact 0');
eq(f.below_threshold, 0, 'fresh: below_threshold 0');
eq(f.capped, 0, 'fresh: capped 0');
eq(f.kept, 0, 'fresh: kept 0');
eq(Object.keys(f.rejected).length, REJECTION_REASONS.length, 'fresh: one bucket per rejection reason');
eq(REJECTION_REASONS.every(r => f.rejected[r] === 0), true, 'fresh: every rejection bucket 0');

// ── recordRejection increments the right bucket, ignores unknown/missing ──────
recordRejection(f, 'employer_mismatch');
recordRejection(f, 'employer_mismatch');
recordRejection(f, 'former_employee');
eq(f.rejected.employer_mismatch, 2, 'recordRejection counts employer_mismatch');
eq(f.rejected.former_employee, 1, 'recordRejection counts former_employee');
recordRejection(f, 'not_a_real_reason'); // no-op, must not throw or add a key
eq(f.rejected.not_a_real_reason, undefined, 'unknown reason is ignored');
recordRejection(null, 'employer_mismatch'); // missing funnel is a safe no-op
eq(totalRejectedPeople(f), 3, 'totalRejectedPeople sums all gates');

// ── formatFunnel renders every stage and is dash-free ─────────────────────────
f.discovered_raw = 12; f.after_dedupe = 8; f.no_person = 2; f.no_contact = 1;
f.below_threshold = 1; f.capped = 3; f.kept = 1;
const text = formatFunnel(f, 7);
ok(/run #7 funnel/.test(text), 'formatFunnel names the run id');
ok(/discovered \(raw\)\s*:?\s*12/.test(text), 'formatFunnel shows discovered_raw');
ok(/people rejected/.test(text), 'formatFunnel shows rejected total');
ok(/capped \(over target\)\s*:?\s*3/.test(text), 'formatFunnel shows capped');
ok(/kept \(leads\)/.test(text), 'formatFunnel shows kept');
eq(/[–—]/.test(text), false, 'formatFunnel output has no em/en dashes');

// formatFunnel tolerates a missing funnel (never throws).
ok(typeof formatFunnel(null) === 'string', 'formatFunnel(null) returns a string');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
