// Unit tests for the people-finder's company-match gate in
// src/outbound/provider.js. A person is only attachable when BOTH checks pass:
// employment is current AND their current employer really is the target company.
// A right title at the WRONG company must be rejected. Pure, no DB/network —
// run with `node test-outbound-people.js`.

const assert = require('assert');
const {
  evaluatePersonResult, classifyPersonResult, normalizeCompanyName, companyNamesMatch,
} = require('./src/outbound/provider');

let pass = 0, fail = 0;
function ok(actual, label) {
  try { assert.strictEqual(Boolean(actual), true); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got: ${JSON.stringify(actual)}`); fail++; }
}
function eq(actual, expected, label) {
  try { assert.strictEqual(actual, expected); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`); fail++; }
}

const URL = 'https://linkedin.com/in/some-person';
const hits = [{ title: 'Some Person - Competitive Intelligence', link: URL, snippet: 'Leads competitive intel.' }];

// Base of a well-formed, current, right-company person; tests override fields.
function person(over) {
  return {
    person_name: 'Some Person',
    person_title: 'Head of Competitive Intelligence',
    person_seniority: 'Head',
    profileUrl: URL,
    channel: 'linkedin',
    current_employer: 'Morpho',
    company_match: true,
    employment_verified: true,
    ...over,
  };
}

// ── normalization: legitimate variants collapse to the same token ─────────────
eq(normalizeCompanyName('Morpho'), 'morpho', 'plain name normalizes');
eq(normalizeCompanyName('Morpho Labs'), 'morpho', '"Labs" suffix stripped');
eq(normalizeCompanyName('Morpho Association'), 'morpho', '"Association" suffix stripped');
eq(normalizeCompanyName('MORPHO'), 'morpho', 'casing ignored');
eq(normalizeCompanyName('morpho.org'), 'morpho', 'domain form: TLD stripped');
eq(normalizeCompanyName('Aware, Inc.'), 'aware', '"Inc" and punctuation stripped');

// ── companyNamesMatch: accept variants, reject different companies ────────────
ok(companyNamesMatch('Morpho Labs', 'Morpho'), 'variant "Morpho Labs" matches "Morpho"');
ok(companyNamesMatch('morpho.xyz', 'Morpho'), 'domain form matches plain name');
eq(companyNamesMatch('Aware, Inc.', 'Morpho'), false, 'different company does not match');
eq(companyNamesMatch('Morpho Genetics', 'Morpho'), false, 'no false substring match');
eq(companyNamesMatch('', 'Morpho'), false, 'empty employer never matches');

// ── evaluatePersonResult: the three required cases ────────────────────────────

// 1) Right title + WRONG company → reject, even if the model claims a match.
eq(
  evaluatePersonResult('Morpho', person({ current_employer: 'Aware, Inc.', company_match: true }), hits),
  null,
  'right title at wrong company (Aware) is rejected',
);

// 2) Right title + right company with a name variant "Morpho Labs" → accept.
const accepted = evaluatePersonResult('Morpho', person({ current_employer: 'Morpho Labs' }), hits);
ok(accepted, 'right title at "Morpho Labs" for target "Morpho" is accepted');
eq(accepted && accepted.current_employer, 'Morpho Labs', 'accepted person carries current_employer');
eq(accepted && accepted.company_match, true, 'accepted person marked company_match');

// 3) Right title + NO verifiable employer → reject.
eq(
  evaluatePersonResult('Morpho', person({ current_employer: null, company_match: false }), hits),
  null,
  'right title with no verifiable employer is rejected',
);

// ── extra backstops ───────────────────────────────────────────────────────────
// Model says company_match but the employer actually mismatches → programmatic
// backstop still rejects (title match is never sufficient on its own).
eq(
  evaluatePersonResult('Morpho', person({ current_employer: 'Acme', company_match: true }), hits),
  null,
  'programmatic backstop rejects an unproven company_match claim',
);
// Employer matches but model did not affirm company_match → reject (both gates).
eq(
  evaluatePersonResult('Morpho', person({ current_employer: 'Morpho', company_match: false }), hits),
  null,
  'employer matches but company_match=false is rejected',
);
// Not currently employed → reject regardless of company.
eq(
  evaluatePersonResult('Morpho', person({ employment_verified: false }), hits),
  null,
  'unverified current employment is rejected',
);
// Fabricated profile URL not in the results → reject.
eq(
  evaluatePersonResult('Morpho', person({ profileUrl: 'https://linkedin.com/in/ghost' }), hits),
  null,
  'profile URL absent from results is rejected',
);
// Former employee of THIS company (snippet reads "Ex-Morpho") → reject.
const formerHits = [{ title: 'Some Person - Ex-Morpho', link: URL, snippet: 'Previously at Morpho.' }];
eq(
  evaluatePersonResult('Morpho', person(), formerHits),
  null,
  'former employee of the target company is rejected',
);

// ── classifyPersonResult: each gate reports its own rejection reason ──────────
eq(classifyPersonResult('Morpho', person(), hits).reason, null, 'accepted person has null reason');
eq(
  classifyPersonResult('Morpho', person({ profileUrl: 'https://linkedin.com/in/ghost' }), hits).reason,
  'not_in_hits',
  'reason: profile absent from hits -> not_in_hits',
);
eq(
  classifyPersonResult('Morpho', person({ employment_verified: false }), hits).reason,
  'employment_unverified',
  'reason: unverified employment -> employment_unverified',
);
eq(
  classifyPersonResult('Morpho', person(), formerHits).reason,
  'former_employee',
  'reason: former employee -> former_employee',
);
eq(
  classifyPersonResult('Morpho', person({ company_match: false }), hits).reason,
  'company_match_false',
  'reason: company_match not affirmed -> company_match_false',
);
eq(
  classifyPersonResult('Morpho', person({ current_employer: 'Aware, Inc.', company_match: true }), hits).reason,
  'employer_mismatch',
  'reason: employer name mismatch -> employer_mismatch',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
