// Project convention (see CLAUDE.md): no em-dashes (—) or en-dashes (–) may
// appear in user-facing output, anywhere. This module is the deterministic
// safety net for that rule. LLM output is stylistically sticky, so prompt
// instructions alone occasionally fail; running every AI-generated string
// (briefs, playbooks, talking points, condensed points) through stripDashes
// before it is stored or displayed guarantees nothing leaks to users.
//
// Hyphens (-) in compound words ("pre-meeting", "anti-bot") are NOT touched —
// only the em-dash (U+2014) and en-dash (U+2013) characters are.

const DASH_RE = /[—–]/g; // em-dash (—) + en-dash (–)

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

// Recursively run stripDashes over every string in a value (plain objects,
// arrays, and nested combinations). Non-string leaves pass through untouched.
// Mutates in place and returns the same reference for convenience, so callers
// can do `return sanitizeDashesDeep(parsedAnalysis)`.
function sanitizeDashesDeep(value) {
  if (typeof value === 'string') return stripDashes(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = sanitizeDashesDeep(value[i]);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = sanitizeDashesDeep(value[k]);
    return value;
  }
  return value;
}

module.exports = { DASH_RE, stripDashes, sanitizeDashesDeep };
