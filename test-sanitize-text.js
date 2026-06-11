// Unit tests for src/lib/sanitizeText.js — the punctuation safety net.
// Covers em/en dash stripping and connector-plus replacement, including the
// edge cases that must NOT be touched (currency, counts, versions, product
// names, hyphens). Pure, no DB/network — run with `node test-sanitize-text.js`.

const assert = require('assert');
const { stripDashes, stripPlusConnectors, sanitizeCopy, sanitizeCopyDeep } = require('./src/lib/sanitizeText');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  try { assert.strictEqual(actual, expected); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`); fail++; }
}

// ── connector-plus → " and " ──────────────────────────────────────────────────
eq(stripPlusConnectors('pricing + packaging'), 'pricing and packaging', 'connector-plus between words');
eq(stripPlusConnectors('fast + reliable + cheap'), 'fast and reliable and cheap', 'chained connector-plus');
eq(stripPlusConnectors('a + b'), 'a and b', 'single-letter words');

// ── connector-plus edge cases that must be LEFT ALONE ─────────────────────────
eq(stripPlusConnectors('$20+'), '$20+', 'currency-plus untouched');
eq(stripPlusConnectors('10+ competitors'), '10+ competitors', 'count-plus untouched');
eq(stripPlusConnectors('v2.1+'), 'v2.1+', 'version-plus untouched');
eq(stripPlusConnectors('Copilot+'), 'Copilot+', 'product-name plus (no spaces) untouched');
eq(stripPlusConnectors('Plus+'), 'Plus+', 'plan-name plus untouched');
eq(stripPlusConnectors('C++ and Rust'), 'C++ and Rust', 'tech-name plus untouched');
eq(stripPlusConnectors('pre-meeting anti-bot win/loss'), 'pre-meeting anti-bot win/loss', 'hyphens/slashes untouched');

// ── dashes (regression) ───────────────────────────────────────────────────────
eq(stripDashes('aggressive — and bold'), 'aggressive, and bold', 'em-dash → comma');
eq(stripDashes('range 10–20'), 'range 10, 20', 'en-dash → comma');
eq(stripDashes('pre-meeting'), 'pre-meeting', 'hyphen untouched by stripDashes');

// ── combined + deep ───────────────────────────────────────────────────────────
eq(sanitizeCopy('pricing + packaging — and tiers'), 'pricing and packaging, and tiers', 'sanitizeCopy strips both');
const deep = sanitizeCopyDeep({ a: 'x + y', list: ['p — q', { b: '$5M+ deals' }], n: 5, ok: true });
eq(JSON.stringify(deep), JSON.stringify({ a: 'x and y', list: ['p, q', { b: '$5M+ deals' }], n: 5, ok: true }), 'sanitizeCopyDeep recurses, leaves non-strings/$5M+');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
