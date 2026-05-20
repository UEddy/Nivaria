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

const EMPTY_BODY_THRESHOLD = 200;

// Fingerprints of common bot-challenge / JS-wall pages.
// Each entry: { label, test(rawHtml) -> boolean }.
const BLOCK_FINGERPRINTS = [
  { label: 'Cloudflare challenge',  test: h => /cf-browser-verification|cf-chl-bypass|cf_chl_opt/i.test(h) },
  { label: 'Cloudflare challenge',  test: h => /just a moment\.{0,3}/i.test(h) && /cloudflare/i.test(h) },
  { label: 'Cloudflare challenge',  test: h => /checking your browser before accessing/i.test(h) },
  { label: 'DataDome challenge',    test: h => /captcha-delivery\.com|datadome|dd\.js\b/i.test(h) },
  { label: 'DataDome block',        test: h => /sorry, you have been blocked/i.test(h) },
  { label: 'DataDome block',        test: h => /please enable js and disable any ad ?blocker/i.test(h) },
  { label: 'PerimeterX challenge',  test: h => /\/_px\/|perimeterx|px-captcha/i.test(h) },
  { label: 'Akamai bot manager',    test: h => /access denied[\s\S]{0,200}reference\s*#?\s*\d/i.test(h) },
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

async function fetchPageContent(url) {
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

  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > 2 && text.length < 200) headings.push(text);
  });

  const pricing = extractByKeywords($, ['pricing', 'price', 'plan', 'subscription', 'tier']);
  const features = extractByKeywords($, ['feature', 'capability', 'solution', 'product']);

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 40000);

  const content = {
    title,
    metaDescription,
    ogTitle,
    headings: headings.slice(0, 60),
    pricing: pricing.substring(0, 8000),
    features: features.substring(0, 8000),
    bodyText: bodyText,
  };

  // JS-wall detection — only meaningful once we've measured the visible body.
  const jsWall = detectJsWall(rawHtml, content);
  if (jsWall) throw new BlockedPageError(jsWall, url);

  const emptyReason = detectEmptyContent(content);
  if (emptyReason) throw new EmptyContentError(emptyReason, url);

  const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');

  return { content, hash, url };
}

function extractByKeywords($, keywords) {
  const found = new Set();
  keywords.forEach(kw => {
    $(`[class*="${kw}"], [id*="${kw}"]`).each((_, el) => {
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
  EMPTY_BODY_THRESHOLD,
};
