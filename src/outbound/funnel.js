// Outbound — per-run funnel counters.
//
// A run can end with zero leads for many different reasons, and until now there
// was no way to tell where the candidates died. The funnel records the count at
// every stage of the pipeline so a dry run is diagnosable at a glance, both in
// the server log (formatFunnel) and in the admin UI (see adminPage.js). The
// shape is persisted as JSON on the outbound_runs row (store.updateRun /
// hydrateRun).

// The gates a candidate person can be rejected at inside
// provider.classifyPersonResult, in the order they are checked. Kept in sync
// with that function.
const REJECTION_REASONS = [
  'not_in_hits',
  'employment_unverified',
  'former_employee',
  'company_match_false',
  'employer_mismatch',
];

// Human-readable labels for the log and the admin UI. No em-dashes, en-dashes,
// or connecting "+": these strings surface in user-facing admin output.
const REJECTION_LABELS = {
  not_in_hits: 'Profile not in search results',
  employment_unverified: 'Employment not verified',
  former_employee: 'Former employee of the company',
  company_match_false: 'Company match not affirmed',
  employer_mismatch: 'Employer name did not match',
};

// A fresh, all-zero funnel for one run.
function makeFunnel() {
  const rejected = {};
  for (const r of REJECTION_REASONS) rejected[r] = 0;
  return {
    discovered_raw: 0,     // candidates the model proposed, before dedupe
    after_dedupe: 0,       // survivors of dedupe and the exclusion rules
    peer: 0,               // companies filtered as peers (they sell competitor monitoring)
    no_person: 0,          // companies where findPeople returned no person at all
    rejected,              // people rejected, counted per gate (see REJECTION_REASONS)
    no_contact: 0,         // companies dropped for no usable contact
    below_threshold: 0,    // leads dropped below the score threshold
    capped: 0,             // gate survivors dropped only by the targetCount cap
    kept: 0,               // leads persisted
  };
}

// Increment one rejection gate. A no-op for an unknown reason or a missing
// funnel, so callers never have to guard.
function recordRejection(funnel, reason) {
  if (funnel && funnel.rejected && Object.prototype.hasOwnProperty.call(funnel.rejected, reason)) {
    funnel.rejected[reason] += 1;
  }
}

// Total people rejected across all gates.
function totalRejectedPeople(funnel) {
  if (!funnel || !funnel.rejected) return 0;
  return REJECTION_REASONS.reduce((n, r) => n + (funnel.rejected[r] || 0), 0);
}

// Multi-line summary for the server log at the end of a run.
function formatFunnel(funnel, runId) {
  const f = funnel || makeFunnel();
  const pad = (label) => (label + ':').padEnd(26);
  const lines = [];
  lines.push('[outbound.pipeline] run ' + (runId != null ? '#' + runId + ' ' : '') + 'funnel');
  lines.push('  ' + pad('discovered (raw)') + f.discovered_raw);
  lines.push('  ' + pad('after dedupe/exclusion') + f.after_dedupe);
  lines.push('  ' + pad('peers filtered') + (f.peer || 0));
  lines.push('  ' + pad('no person found') + f.no_person);
  lines.push('  ' + pad('people rejected') + totalRejectedPeople(f));
  for (const r of REJECTION_REASONS) {
    lines.push('    ' + (REJECTION_LABELS[r] + ':').padEnd(34) + (f.rejected[r] || 0));
  }
  lines.push('  ' + pad('no usable contact') + f.no_contact);
  lines.push('  ' + pad('below score threshold') + f.below_threshold);
  lines.push('  ' + pad('capped (over target)') + (f.capped || 0));
  lines.push('  ' + pad('kept (leads)') + f.kept);
  return lines.join('\n');
}

module.exports = {
  makeFunnel, recordRejection, totalRejectedPeople, formatFunnel,
  REJECTION_REASONS, REJECTION_LABELS,
};
