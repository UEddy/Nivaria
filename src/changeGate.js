// Phase 4 — meaningful-change gate.
//
// Runs before the AI. Cheap, rule-based, explainable. Goal: drop trivial
// noise (whitespace, date rollovers, "237 → 241" counters, meta tweaks)
// without burning Anthropic tokens or pushing useless Slack alerts —
// while NEVER suppressing a real pricing or structural change.
//
// Returns { meaningful: bool, category, reason }. Reason is a human-readable
// explanation that gets persisted on the change row for transparency.
//
// Bias: when in doubt, classify as meaningful. The cost of a false-positive
// gate (one wasted AI call) is much lower than a false-negative
// (silently swallowing a real competitive move).

// Currency / pricing patterns — if these change at all, ALWAYS meaningful.
// Matches: $49, €1.299, $9/mo, $34 / month, 30% off, 25 % discount, ¥1000, ₹500
const CURRENCY_RE = /[$€£¥₹]\s*\d+(?:[.,]\d+)*(?:\s*\/\s*(?:mo|month|year|yr|seat|user))?|\b\d+(?:[.,]\d+)?\s*%\s*(?:off|discount)\b/gi;

// Date / time tokens we treat as "non-substantive" when nothing else changes.
// ISO dates FIRST (otherwise the year alternative eats the first four digits of
// "2025-11-04" and leaves "-11-04" to be misclassified as plain numbers).
const DATE_TOKEN_RE   = /\b\d{4}-\d{2}-\d{2}\b|\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,7}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/gi;
const NUMBER_RE       = /\b\d+(?:[.,]\d+)?\b/g;

function newRe(re) { return new RegExp(re.source, re.flags); }

function normWhitespace(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
// normForCompare collapses Unicode letters/numbers into themselves and turns
// every run of other characters (whitespace, punctuation, emoji, currency
// glyphs) into a single space. Two strings that differ only in spacing,
// punctuation, or letter casing will compare equal — which is exactly what
// the "whitespace/punctuation/case-only" trivial bucket needs.
function normForCompare(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function stripDatesAndNumbers(s) {
  return String(s || '').replace(newRe(DATE_TOKEN_RE), ' ').replace(newRe(NUMBER_RE), ' ');
}

function currencyTokens(s) {
  const matches = String(s || '').match(newRe(CURRENCY_RE)) || [];
  return new Set(matches.map(m => m.toLowerCase().replace(/\s+/g, '')));
}

function hasCurrencyDelta(beforeText, afterText) {
  const b = currencyTokens(beforeText);
  const a = currencyTokens(afterText);
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  for (const x of b) if (!a.has(x)) return true;
  return false;
}

function headingsSignature(headings) {
  return (headings || []).map(h => normForCompare(h)).sort().join('|');
}

function tokensFrom(text, re) {
  return String(text || '').match(newRe(re)) || [];
}

function isDateLikeToken(t) {
  return /^(?:19|20)\d{2}$/.test(t)
      || /^\d{4}-\d{2}-\d{2}$/.test(t)
      || /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,7}$/i.test(t)
      || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(t);
}

// Public: classify a diff.
//
// `before` and `after` are content objects from scraper.fetchPageContent:
//    { title, metaDescription, ogTitle, headings, pricing, features, bodyText }
// `diff` is the diff object from scraper.generateDiff (only used to short-circuit
// on first observations).
function classifyChange(before, after, diff) {
  if (!before || (diff && diff.isFirstCheck)) {
    return { meaningful: true, category: 'first_seen', reason: 'first observation of this competitor — needs baseline analysis' };
  }

  const beforeAll = [before.title, before.bodyText, before.pricing, before.features].map(s => s || '').join('\n');
  const afterAll  = [after.title,  after.bodyText,  after.pricing,  after.features ].map(s => s || '').join('\n');

  // ── ALWAYS meaningful #1: currency / pricing pattern delta anywhere.
  // This is the highest-signal change we monitor and must never be suppressed,
  // even if the surrounding copy was reflowed.
  if (hasCurrencyDelta(beforeAll, afterAll)) {
    return { meaningful: true, category: 'pricing_pattern', reason: 'currency or % pattern changed' };
  }

  // ── ALWAYS meaningful #2: heading set changed (added, removed, renamed).
  // Comparison is case- and whitespace-insensitive so pure restyling doesn't
  // trip it — only real structural changes do.
  if (headingsSignature(before.headings) !== headingsSignature(after.headings)) {
    return { meaningful: true, category: 'headings_changed', reason: 'page heading set added, removed, or renamed' };
  }

  // ── Meta-description-only change.
  // All visible fields match (after normalization), only metaDescription
  // differs. Often a copy tweak by marketing with no strategic implication.
  // Checked before the whitespace bucket so meta-only is reported with the
  // more specific label.
  const visibleFieldsMatch =
       normForCompare(before.title)    === normForCompare(after.title)
    && normForCompare(before.bodyText) === normForCompare(after.bodyText)
    && normForCompare(before.pricing)  === normForCompare(after.pricing)
    && normForCompare(before.features) === normForCompare(after.features);
  if (visibleFieldsMatch && normForCompare(before.metaDescription) !== normForCompare(after.metaDescription)) {
    return { meaningful: false, category: 'meta_only', reason: 'only the meta description tag changed' };
  }

  // ── Whitespace / punctuation / case-only.
  const beforeNorm = normForCompare(beforeAll);
  const afterNorm  = normForCompare(afterAll);
  if (beforeNorm === afterNorm) {
    return { meaningful: false, category: 'whitespace_or_case_only', reason: 'differs only in whitespace, punctuation, or letter casing' };
  }

  // ── Date-only or numeric-only delta.
  // Strip dates first, then extract remaining numbers — that way an ISO date
  // like "2025-11-04" is one date token, not three number tokens.
  const beforeStripped = normForCompare(stripDatesAndNumbers(beforeAll));
  const afterStripped  = normForCompare(stripDatesAndNumbers(afterAll));
  if (beforeStripped === afterStripped) {
    const beforeDates = new Set(tokensFrom(beforeAll, DATE_TOKEN_RE).map(t => t.toLowerCase()));
    const afterDates  = new Set(tokensFrom(afterAll,  DATE_TOKEN_RE).map(t => t.toLowerCase()));
    const beforeNoDates = beforeAll.replace(newRe(DATE_TOKEN_RE), ' ');
    const afterNoDates  = afterAll.replace(newRe(DATE_TOKEN_RE),  ' ');
    const beforeNums = new Set(tokensFrom(beforeNoDates, NUMBER_RE).map(t => t.toLowerCase()));
    const afterNums  = new Set(tokensFrom(afterNoDates,  NUMBER_RE).map(t => t.toLowerCase()));

    const addedDates   = [...afterDates ].filter(t => !beforeDates.has(t));
    const removedDates = [...beforeDates].filter(t => !afterDates.has(t));
    const addedNums    = [...afterNums  ].filter(t => !beforeNums.has(t));
    const removedNums  = [...beforeNums ].filter(t => !afterNums.has(t));

    const dateChanges = addedDates.length + removedDates.length;
    const numChanges  = addedNums.length  + removedNums.length;
    const total       = dateChanges + numChanges;

    if (total === 0) {
      return { meaningful: false, category: 'whitespace_or_case_only', reason: 'no token-level differences after normalization' };
    }
    if (total <= 6) {
      if (numChanges === 0) {
        return { meaningful: false, category: 'date_only', reason: `only ${dateChanges} date/time token(s) changed: [${removedDates.join(',')}] → [${addedDates.join(',')}]` };
      }
      return {
        meaningful: false,
        category: 'numeric_only',
        reason: `${dateChanges} date and ${numChanges} numeric token(s) changed (dates: [${removedDates.join(',')}] → [${addedDates.join(',')}]; nums: [${removedNums.join(',')}] → [${addedNums.join(',')}])`,
      };
    }
    // Many tokens flipped — fall through to size/default logic.
  }

  // ── Word-count delta: meaningful if body text grew/shrank by >5%.
  const beforeLen = (before.bodyText || '').length;
  const afterLen  = (after.bodyText  || '').length;
  const baseline  = Math.max(beforeLen, 1);
  const delta     = Math.abs(afterLen - beforeLen) / baseline;
  if (delta > 0.05) {
    return {
      meaningful: true,
      category: 'body_size_change',
      reason: `body text size changed by ${(delta * 100).toFixed(1)}% (${beforeLen} → ${afterLen} chars)`,
    };
  }

  // ── Default: text content differs in a way we can't cheaply prove trivial.
  // Hand it to the AI rather than guess.
  return { meaningful: true, category: 'content_change', reason: 'text content differs in ways the gate could not cheaply classify as trivial' };
}

module.exports = {
  classifyChange,
  // exported for tests
  hasCurrencyDelta,
  headingsSignature,
  isDateLikeToken,
  CURRENCY_RE,
  DATE_TOKEN_RE,
  NUMBER_RE,
};
