// Project convention (see CLAUDE.md): user-facing output may never contain
// em-dashes (—), en-dashes (–), or the "+" character used as a prose connector
// between words ("pricing + packaging"). This module is the deterministic safety
// net for that rule. LLM output is stylistically sticky, so prompt instructions
// alone occasionally fail; running every AI-generated string (briefs, playbooks,
// talking points, condensed points) through these helpers before it is stored or
// displayed guarantees nothing leaks to users.
//
// What is NOT touched:
//   · Ordinary hyphens (-) in compound words ("pre-meeting", "anti-bot").
//   · "+" attached to digits/currency/versions ("$20+", "10+ competitors",
//     "v2.1+") — the connector rule requires whitespace on BOTH sides.
//   · "+" inside product/plan names with no surrounding spaces ("Copilot+",
//     "Plus+").

const DASH_RE = /[—–]/g; // em-dash (—) + en-dash (–)

// Connector-plus: a "+" with whitespace on both sides, between word characters.
// Matches "fast + reliable"; does NOT match "$20+", "10+ x", "Copilot+", "v2.1+"
// (none of those have a space on both sides of the +).
const PLUS_CONNECTOR_RE = /(\w)\s+\+\s+(\w)/g;

// Replace em/en dashes (with any surrounding whitespace) with ", ", the safe
// default. Then collapse any doubled comma the swap can create, and drop a
// leading ", " when the string began with a dash. A bare dash with no spaces
// (e.g. "word—word") also becomes "word, word".
function stripDashes(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/^\s*,\s*/, '');
}

// Replace a "+" used as a connector between words with " and ". Loops so chains
// like "a + b + c" fully resolve (the regex consumes the word char after each
// "+", so adjacent matches need another pass).
function stripPlusConnectors(text) {
  if (typeof text !== 'string') return text;
  let out = text, prev;
  do { prev = out; out = out.replace(PLUS_CONNECTOR_RE, '$1 and $2'); } while (out !== prev);
  return out;
}

// Full user-facing-copy sanitizer: strip em/en dashes AND connector-plus.
function sanitizeCopy(text) {
  if (typeof text !== 'string') return text;
  return stripPlusConnectors(stripDashes(text));
}

// Recursively run sanitizeCopy over every string in a value (plain objects,
// arrays, and nested combinations). Non-string leaves pass through untouched.
// Mutates in place and returns the same reference, so callers can do
// `return sanitizeCopyDeep(parsedAnalysis)`.
function sanitizeCopyDeep(value) {
  if (typeof value === 'string') return sanitizeCopy(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = sanitizeCopyDeep(value[i]);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = sanitizeCopyDeep(value[k]);
    return value;
  }
  return value;
}

module.exports = {
  DASH_RE, PLUS_CONNECTOR_RE,
  stripDashes, stripPlusConnectors,
  sanitizeCopy, sanitizeCopyDeep,
};
