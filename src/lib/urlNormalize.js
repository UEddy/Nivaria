'use strict';

// ── Competitor URL normalization ─────────────────────────────────────────────
// Single source of truth for BOTH concerns, so they can never drift:
//
//   1. Protocol-completion + validation. A user should not have to type
//      "https://". We accept "apple.com", "www.apple.com", "apple.com/pricing",
//      or a full "https://apple.com" and produce a complete, monitorable URL,
//      defaulting a missing scheme to https.
//
//   2. Duplicate detection. canonicalUrlKey() collapses the parts that do not
//      change the page identity (scheme, "www.", a trailing slash) so that
//      "apple.com" is recognized as the same site as an existing
//      "https://www.apple.com", while a different page ("apple.com/iphone")
//      stays distinct. The same key powers both, so completion and dedup always
//      agree.

const MAX_URL_LEN = 2048;

// Prepend https:// when the input carries no scheme. We only auto-complete the
// http/https family. An input that already declares any "scheme://" is left
// untouched so validation below can accept http(s) and reject anything else
// (ftp:, file:, etc.) rather than silently rewriting it.
function ensureProtocol(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;   // already "scheme://…"
  return 'https://' + s.replace(/^\/+/, '');               // bare domain / path
}

// A hostname is plausible when it has at least one dot and a 2+ letter TLD. This
// rejects obvious garbage ("http", "apple", "not a url") while staying lenient
// about scheme and www. new URL() lowercases and punycodes IDNs before we test.
function isPlausibleHostname(host) {
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host);
}

// Parse + validate a user-entered competitor URL. Returns { url, error }:
//   • url   — the completed, cleaned URL to store and monitor (scheme added,
//             host lowercased, a bare-root trailing slash dropped; "www." and
//             the path/query are preserved so we monitor exactly the page meant).
//   • error — a clear, user-facing message when the input is not a plausible URL.
function normalizeCompetitorUrl(raw) {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) return { url: null, error: 'URL is required' };
  if (input.length > MAX_URL_LEN) {
    return { url: null, error: `URL must be ${MAX_URL_LEN} characters or fewer` };
  }

  let u;
  try {
    u = new URL(ensureProtocol(input));
  } catch {
    return { url: null, error: 'Enter a valid website, for example apple.com or apple.com/pricing' };
  }

  if (!['http:', 'https:'].includes(u.protocol)) {
    return { url: null, error: 'Website must use http or https' };
  }
  if (!isPlausibleHostname(u.hostname)) {
    return { url: null, error: 'Enter a valid website, for example apple.com or apple.com/pricing' };
  }

  // Rebuild a clean URL. new URL() reports a host-only address with pathname "/",
  // so drop that lone slash so the stored value reads "https://apple.com" rather
  // than "https://apple.com/". u.host keeps a port if one was given.
  const path    = u.pathname === '/' ? '' : u.pathname;
  const cleaned = `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  return { url: cleaned, error: null };
}

// Canonical key for duplicate detection: scheme-, www-, and trailing-slash-
// insensitive, but path- and query-sensitive. Returns null when the input can't
// be parsed (callers validate with normalizeCompetitorUrl first). Examples:
//   apple.com               → "apple.com"
//   www.apple.com           → "apple.com"
//   https://apple.com/      → "apple.com"
//   http://APPLE.com        → "apple.com"
//   apple.com/iphone        → "apple.com/iphone"   (distinct from the root)
function canonicalUrlKey(raw) {
  let u;
  try {
    u = new URL(ensureProtocol(String(raw == null ? '' : raw).trim()));
  } catch {
    return null;
  }
  const host = u.host.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, ''); // drop trailing slash(es)
  return host + path + u.search;
}

module.exports = { normalizeCompetitorUrl, canonicalUrlKey, ensureProtocol, MAX_URL_LEN };
