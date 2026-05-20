const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

class BlockedPageError extends Error {
  constructor(reason, url) {
    super(`Blocked page detected: ${reason}`);
    this.name = 'BlockedPageError';
    this.code = 'BLOCKED_PAGE';
    this.reason = reason;
    this.url = url;
  }
}

class EmptyContentError extends Error {
  constructor(reason, url) {
    super(`Empty content: ${reason}`);
    this.name = 'EmptyContentError';
    this.code = 'EMPTY_CONTENT';
    this.reason = reason;
    this.url = url;
  }
}

class SelectorNotFoundError extends Error {
  constructor(selector, url) {
    super(`Selector "${selector}" matched no elements on the page`);
    this.name = 'SelectorNotFoundError';
    this.code = 'SELECTOR_NOT_FOUND';
    this.selector = selector;
    this.url = url;
  }
}

const EMPTY_BODY_THRESHOLD = 200;

// Fingerprints of common bot-challenge / JS-wall pages.
// Each entry: { label, test(rawHtml) -> boolean }.
//
// Tightened to require challenge-specific contexts (script tags, cookie names,
// challenge URLs) rather than bare vendor keywords — otherwise a competitor
// blog post that *mentions* "DataDome" or "Cloudflare" in prose would be
// permanently mis-flagged as blocked.
const BLOCK_FINGERPRINTS = [
  // Cloudflare
  { label: 'Cloudflare challenge',  test: h => /cf-browser-verification|cf-chl-bypass|cf_chl_opt|cdn-cgi\/challenge-platform/i.test(h) },
  { label: 'Cloudflare challenge',  test: h => /just a moment\.{0,3}/i.test(h) && /cloudflare/i.test(h) },
  { label: 'Cloudflare challenge',  test: h => /checking your browser before accessing/i.test(h) },
  // DataDome — require script context, challenge URL, or cookie/marker pattern
  { label: 'DataDome challenge',    test: h => /captcha-delivery\.com/i.test(h) },
  { label: 'DataDome challenge',    test: h => /<script[^>]+(?:datadome|dd\.js)/i.test(h) },
  { label: 'DataDome challenge',    test: h => /datadome[_-]?(?:cookie|block|tags)|window\.ddjskey/i.test(h) },
  { label: 'DataDome block',        test: h => /sorry, you have been blocked/i.test(h) },
  { label: 'DataDome block',        test: h => /please enable js and disable any ad ?blocker/i.test(h) },
  // PerimeterX — require their specific JS globals or URL paths, not the bare brand name
  { label: 'PerimeterX challenge',  test: h => /window\._pxAppId|_pxhd|px-captcha|\/_px_\//i.test(h) },
  // Akamai — require both signals together
  { label: 'Akamai bot manager',    test: h => /access denied/i.test(h) && /reference\s*#?\s*\d{6,}/i.test(h) },
];

function detectBlockPage(rawHtml) {
  const html = String(rawHtml || '');
  for (const fp of BLOCK_FINGERPRINTS) {
    if (fp.test(html)) return fp.label;
  }
  return null;
}

function detectJsWall(rawHtml, content) {
  // Generic "you need to enable JavaScript" walls where the visible body is sparse.
  const html = String(rawHtml || '');
  const jsWallSignal = /you need to enable javascript|please enable javascript|enable javascript to (continue|run|view)/i.test(html);
  if (jsWallSignal && content.bodyText.length < 500) {
    return 'JavaScript-required wall (rendered shell only)';
  }
  return null;
}

function detectEmptyContent(content) {
  if (content.bodyText.length < EMPTY_BODY_THRESHOLD && content.headings.length === 0) {
    return `bodyText=${content.bodyText.length} chars, headings=${content.headings.length}, title="${content.title || ''}"`;
  }
  return null;
}

async function fetchPageContent(url, opts = {}) {
  const cssSelector = opts.cssSelector ? String(opts.cssSelector).trim() : null;

  const response = await axios.get(url, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
    maxRedirects: 5,
  });

  const rawHtml = response.data;

  // Block detection runs against raw HTML before stripping, because the
  // strip step removes scripts and noscript blocks (which carry the signal).
  const blockLabel = detectBlockPage(rawHtml);
  if (blockLabel) throw new BlockedPageError(blockLabel, url);

  const $ = cheerio.load(rawHtml);

  $('script, style, noscript, svg, [aria-hidden="true"], .sr-only').remove();
  $('nav, footer, header').remove();
  $('[class*="cookie"], [id*="cookie"], [class*="banner"], [class*="popup"]').remove();

  const title = $('title').text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';

  // ── Scope selection ─────────────────────────────────────────────────────────
  // If the competitor pinned a CSS selector, we monitor ONLY that region.
  // Title / meta tags still come from <head> because that's how browsers and
  // OG previews work — and stripping them wouldn't reduce noise.
  let scope;
  let scopeLabel;
  if (cssSelector) {
    let matched;
    try {
      matched = $(cssSelector);
    } catch (selErr) {
      // cheerio throws on a few exotic selectors; treat as "selector not found"
      throw new SelectorNotFoundError(cssSelector, url);
    }
    if (!matched || matched.length === 0) {
      throw new SelectorNotFoundError(cssSelector, url);
    }
    scope = matched;
    scopeLabel = cssSelector;
  } else {
    scope = $('body');
    scopeLabel = null;
  }

  const headings = [];
  scope.find('h1, h2, h3').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > 2 && text.length < 200) headings.push(text);
  });
  // If the scope element itself is a heading, include it too
  scope.filter('h1, h2, h3').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > 2 && text.length < 200) headings.push(text);
  });

  const pricing = extractByKeywords($, scope, ['pricing', 'price', 'plan', 'subscription', 'tier']);
  const features = extractByKeywords($, scope, ['feature', 'capability', 'solution', 'product']);

  const bodyText = scope.text().replace(/\s+/g, ' ').trim().substring(0, 40000);

  const content = {
    title,
    metaDescription,
    ogTitle,
    headings: headings.slice(0, 60),
    pricing: pricing.substring(0, 8000),
    features: features.substring(0, 8000),
    bodyText: bodyText,
    scope: scopeLabel,
  };

  // JS-wall detection — only meaningful once we've measured the visible body.
  const jsWall = detectJsWall(rawHtml, content);
  if (jsWall) throw new BlockedPageError(jsWall, url);

  const emptyReason = detectEmptyContent(content);
  if (emptyReason) throw new EmptyContentError(emptyReason, url);

  const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');

  return { content, hash, url };
}

function extractByKeywords($, scope, keywords) {
  const found = new Set();
  keywords.forEach(kw => {
    scope.find(`[class*="${kw}"], [id*="${kw}"]`).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > 30) found.add(text.substring(0, 3000));
    });
    // Also check whether any scope-root element itself matches
    scope.filter(`[class*="${kw}"], [id*="${kw}"]`).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > 30) found.add(text.substring(0, 3000));
    });
  });
  return Array.from(found).join('\n\n');
}

function generateDiff(before, after) {
  if (!before) {
    return {
      isFirstCheck: true,
      added: [],
      removed: [],
      beforeHeadings: [],
      afterHeadings: after?.headings || [],
      beforePricing: '',
      afterPricing: after?.pricing || '',
      beforeFeatures: '',
      afterFeatures: after?.features || '',
      beforeTitle: '',
      afterTitle: after?.title || '',
    };
  }

  const beforeWords = new Set((before.bodyText || '').toLowerCase().split(/\W+/).filter(w => w.length > 4));
  const afterWords = new Set((after.bodyText || '').toLowerCase().split(/\W+/).filter(w => w.length > 4));

  const added = [...afterWords].filter(w => !beforeWords.has(w)).slice(0, 80);
  const removed = [...beforeWords].filter(w => !afterWords.has(w)).slice(0, 80);

  return {
    isFirstCheck: false,
    added,
    removed,
    beforeHeadings: before.headings || [],
    afterHeadings: after.headings || [],
    beforePricing: before.pricing || '',
    afterPricing: after.pricing || '',
    beforeFeatures: before.features || '',
    afterFeatures: after.features || '',
    beforeTitle: before.title || '',
    afterTitle: after.title || '',
    beforeMeta: before.metaDescription || '',
    afterMeta: after.metaDescription || '',
  };
}

module.exports = {
  fetchPageContent,
  generateDiff,
  detectBlockPage,
  detectJsWall,
  detectEmptyContent,
  BlockedPageError,
  EmptyContentError,
  SelectorNotFoundError,
  EMPTY_BODY_THRESHOLD,
};
