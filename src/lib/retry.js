// Shared rate-limit retry helper for outbound API calls (Serper, Anthropic).
//
// Providers meter us per minute, and the outbound pipeline is bursty: one run
// fires a search plus two or three model calls per company. When a provider
// answers 429 the right move is to wait and try again, not to fail the lead and
// not to hammer the endpoint. withRetry() backs off 1s, 2s, 4s and honours a
// Retry-After header whenever the response carries one.
//
// Only rate-limit and overloaded responses are retried. Everything else (a bad
// key, a malformed request, a timeout) rethrows immediately so callers keep
// their existing error handling.

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];

// Cap on a server-supplied Retry-After. A provider asking us to wait ten minutes
// would stall a background run past any useful lifetime, so we give up instead.
const MAX_RETRY_AFTER_MS = 60000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Both shapes we see in this codebase: axios (err.response.status) and the
// Anthropic SDK (err.status). 429 = rate limited, 529 = Anthropic overloaded.
function isRetryableRateLimit(err) {
  const status = err?.status || err?.response?.status;
  if (status === 429 || status === 529) return true;
  const msg = String(err?.message || '');
  return /rate.?limit|too many requests|overloaded/i.test(msg);
}

// Header bags differ by client: axios gives a plain object, the Anthropic SDK a
// fetch Headers instance. Read either.
function readHeader(err, name) {
  const bags = [err?.headers, err?.response?.headers];
  for (const bag of bags) {
    if (!bag) continue;
    if (typeof bag.get === 'function') {
      const v = bag.get(name);
      if (v != null) return v;
    } else if (bag[name] != null) {
      return bag[name];
    }
  }
  return null;
}

// Retry-After is either a delay in seconds or an HTTP date. Returns ms, or null
// when the header is absent or unparseable.
function retryAfterMs(err) {
  const raw = readHeader(err, 'retry-after');
  if (raw == null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(String(raw));
  if (!Number.isNaN(at)) {
    const wait = at - Date.now();
    if (wait > 0) return Math.min(wait, MAX_RETRY_AFTER_MS);
    return 0;
  }
  return null;
}

// Run fn(), retrying only on rate-limit / overloaded responses. Waits the longer
// of the provider's Retry-After and our own backoff step. Rethrows the last
// error once the attempts are spent, so callers decide how to degrade.
async function withRetry(fn, { backoff = DEFAULT_BACKOFF_MS, label = 'call' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableRateLimit(err) || attempt === backoff.length) throw err;
      const suggested = retryAfterMs(err);
      const wait = Math.max(backoff[attempt], suggested == null ? 0 : suggested);
      console.warn(
        `[retry] ${label} rate limited, waiting ${wait}ms `
        + `(attempt ${attempt + 1} of ${backoff.length})`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, sleep, isRetryableRateLimit, retryAfterMs, DEFAULT_BACKOFF_MS };
