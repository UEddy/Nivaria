const Anthropic = require('@anthropic-ai/sdk');

let client;

function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

class AIAnalysisError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'AIAnalysisError';
    this.code = code; // ai_auth_failed | ai_out_of_credits | ai_rate_limited | ai_service_error | ai_invalid_response | ai_error
    this.cause = cause;
  }
}

function categorizeAnthropicError(err) {
  const status = err?.status ?? err?.statusCode;
  const msg = String(err?.message || err || '');

  if (status === 401 || /authentication_error|invalid x-api-key|invalid api key/i.test(msg)) {
    return new AIAnalysisError('ai_auth_failed',
      `Anthropic API key rejected (401). Check ANTHROPIC_API_KEY in .env.`, err);
  }
  if (status === 402 || /credit balance|plans & billing|insufficient_quota|billing/i.test(msg)) {
    return new AIAnalysisError('ai_out_of_credits',
      `Anthropic account is out of credits. Refill at console.anthropic.com → Plans & Billing.`, err);
  }
  if (status === 429 || /rate_limit|too many requests/i.test(msg)) {
    return new AIAnalysisError('ai_rate_limited',
      `Anthropic rate limit hit. Will retry on next scheduled check.`, err);
  }
  if (status >= 500 && status < 600) {
    return new AIAnalysisError('ai_service_error',
      `Anthropic service error (${status}). Will retry on next scheduled check.`, err);
  }
  return new AIAnalysisError('ai_error', `AI analysis failed: ${msg}`, err);
}

const SYSTEM_PROMPT = `You are a competitive intelligence analyst writing battle cards for a SaaS sales team.
You analyze diffs of competitor website content and decide what — if anything — the sales team needs to know.

THREAT-LEVEL CALIBRATION (apply strictly):

LOW — cosmetic or organizational, no strategic implication:
  • Copy refresh, wording polish, design tweak, image swap
  • New testimonial, customer logo update, blog rotation
  • Footer / nav / legal text update
  • Date or year rollover ("© 2025" → "© 2026")
  → If the change is mostly cosmetic or organizational with no strategic implication, classify as low.

MEDIUM — substantive but not urgent:
  • New feature added to the feature list
  • Repositioning or rewording of an existing feature
  • Expanded use-case or industry section
  • New integration, partnership, or certification mentioned
  • Hiring page surge, new exec announcement

HIGH — directly affects a live sales conversation, reserve for these only:
  • Pricing change (any tier added, removed, repriced, or repackaged)
  • Plan structure change (seat caps changed, limits added/removed)
  • New product tier or product line launched
  • Removal of a feature we compete on
  • Competitor entering a new market segment or geography
  • Explicit comparison page targeting our product

Reserve "high" for changes that would directly affect a sales conversation.
When in doubt between two levels, choose the lower one.

OUTPUT FORMAT (strict): return ONE JSON object, no markdown fences, no prose
before or after. The object MUST contain these fields, all required:

{
  "is_meaningful": true | false,
  "changed_what":  string (1 sentence, factual description of what actually changed),
  "why_it_matters": string (1-2 sentences explaining strategic relevance — write "no strategic implication" if is_meaningful is false),
  "threat_level":  "low" | "medium" | "high",
  "threat_reasoning": string (1-2 sentences justifying the threat level using the calibration above),
  "recommended_response": string (specific action the sales/product team should take — write "no action needed" if is_meaningful is false),
  "talking_points": [ array of 1-4 short strings the sales team can use; empty array if is_meaningful is false ],
  "headline": string (max 100 chars, punchy summary suitable for a notification),
  "summary":  string (2-3 sentences),
  "key_changes": [
    { "category": "pricing" | "features" | "positioning" | "messaging" | "partnership" | "other",
      "description": string,
      "impact": string }
  ],
  "opportunity": string (any opportunity this creates for our company, or empty string)
}

If after reading the diff you conclude there is no real change worth a sales
team's attention — e.g. only whitespace shuffled, only a year incremented,
only meta tags rewritten — set is_meaningful=false, threat_level="low", and
fill the other fields with the trivial-case defaults above. Do NOT invent
strategic significance for changes that don't have it.`;

function buildPrompt(competitor, diff) {
  return `Competitor: ${competitor.name}
URL: ${competitor.url}
${competitor.description ? `Internal context: ${competitor.description}\n` : ''}
CHANGES DETECTED:

Page title: "${diff.beforeTitle || ''}" → "${diff.afterTitle || ''}"
Meta description: "${diff.beforeMeta || ''}" → "${diff.afterMeta || ''}"

Previous headings: ${(diff.beforeHeadings || []).slice(0, 20).join(' | ')}
Current headings:  ${(diff.afterHeadings  || []).slice(0, 20).join(' | ')}

Previous pricing section: ${(diff.beforePricing || '').substring(0, 2000) || 'N/A'}
Current pricing section:  ${(diff.afterPricing  || '').substring(0, 2000) || 'N/A'}

Previous features section: ${(diff.beforeFeatures || '').substring(0, 1500) || 'N/A'}
Current features section:  ${(diff.afterFeatures  || '').substring(0, 1500) || 'N/A'}

Notable new words/phrases: ${(diff.added   || []).slice(0, 40).join(', ')}
Removed words/phrases:     ${(diff.removed || []).slice(0, 40).join(', ')}

Apply the threat-level calibration in the system prompt. Return the JSON object only.`;
}

// Required keys on a successful AI response. Anything missing → retry once
// with an instruction to comply with the schema.
const REQUIRED_KEYS = [
  'is_meaningful', 'changed_what', 'why_it_matters', 'threat_level',
  'threat_reasoning', 'recommended_response', 'talking_points',
  'headline', 'summary', 'key_changes',
];

function tryParseAnalysis(text) {
  const trimmed = String(text || '').trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { ok: false, reason: 'no JSON object found in response' };
  let obj;
  try { obj = JSON.parse(jsonMatch[0]); }
  catch (e) { return { ok: false, reason: `JSON parse error: ${e.message}` }; }

  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) return { ok: false, reason: `missing required key "${k}"` };
  }
  if (!['low', 'medium', 'high'].includes(obj.threat_level)) {
    return { ok: false, reason: `invalid threat_level "${obj.threat_level}"` };
  }
  if (typeof obj.is_meaningful !== 'boolean') {
    return { ok: false, reason: `is_meaningful must be boolean, got ${typeof obj.is_meaningful}` };
  }
  if (!Array.isArray(obj.talking_points)) obj.talking_points = [];
  if (!Array.isArray(obj.key_changes))    obj.key_changes    = [];
  if (typeof obj.opportunity !== 'string') obj.opportunity   = '';
  return { ok: true, value: obj };
}

// Single call to Anthropic. Returns { analysis, usage, raw }.
async function callAnthropic(prompt, retryContext) {
  const messages = retryContext
    ? [
        { role: 'user',      content: prompt },
        { role: 'assistant', content: retryContext.priorRaw || '' },
        { role: 'user',      content:
          `Your previous response could not be parsed: ${retryContext.reason}. ` +
          `Respond again with ONLY the JSON object, no prose, no markdown fences. ` +
          `Every required field must be present and threat_level must be exactly "low", "medium", or "high".` },
      ]
    : [{ role: 'user', content: prompt }];

  let response;
  try {
    response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages,
    });
  } catch (err) {
    throw categorizeAnthropicError(err);
  }

  const raw = response.content?.[0]?.text || '';
  const usage = response.usage
    ? { input_tokens: response.usage.input_tokens || 0, output_tokens: response.usage.output_tokens || 0 }
    : { input_tokens: 0, output_tokens: 0 };

  return { raw, usage };
}

async function analyzeChange(competitor, before, after, diff) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { analysis: buildFallbackAnalysis(competitor, diff), usage: null };
  }

  const prompt = buildPrompt(competitor, diff);

  // First attempt
  const first = await callAnthropic(prompt, null);
  const firstParse = tryParseAnalysis(first.raw);
  if (firstParse.ok) {
    return { analysis: firstParse.value, usage: first.usage };
  }

  // Single retry — feed back the bad response and ask for compliance.
  const second = await callAnthropic(prompt, { priorRaw: first.raw, reason: firstParse.reason });
  const secondParse = tryParseAnalysis(second.raw);
  if (secondParse.ok) {
    return {
      analysis: secondParse.value,
      usage: {
        input_tokens:  (first.usage.input_tokens  || 0) + (second.usage.input_tokens  || 0),
        output_tokens: (first.usage.output_tokens || 0) + (second.usage.output_tokens || 0),
      },
    };
  }

  throw new AIAnalysisError('ai_invalid_response',
    `AI response failed schema validation twice: ${firstParse.reason}; retry: ${secondParse.reason}`, null);
}

function buildFallbackAnalysis(competitor, diff) {
  const hasHeadingChanges = (diff?.afterHeadings || []).some(h => !(diff?.beforeHeadings || []).includes(h));
  const hasPricingChanges = (diff?.afterPricing || '') !== (diff?.beforePricing || '');
  const threatLevel = hasPricingChanges ? 'medium' : 'low';

  return {
    is_meaningful: true,  // fallback is conservative — assume the change matters until AI says otherwise
    changed_what: `${competitor.name} updated their website content`,
    why_it_matters: 'Automated detection without AI analysis — manual review recommended to determine strategic relevance.',
    threat_level: threatLevel,
    threat_reasoning: 'Threat level estimated from heuristics (pricing-section delta) without LLM reasoning.',
    recommended_response: 'Review the competitor page manually and enable AI analysis (set ANTHROPIC_API_KEY) for detailed intelligence.',
    talking_points: ['Competitor made updates — manual review recommended'],
    headline: `${competitor.name} updated their website content`,
    summary: `Changes detected on ${competitor.url}. ${hasPricingChanges ? 'Pricing section was modified. ' : ''}${hasHeadingChanges ? 'Page structure and headings changed. ' : ''}Enable ANTHROPIC_API_KEY for detailed AI analysis.`,
    key_changes: [{ category: 'other', description: 'Page content changed', impact: 'Requires manual review' }],
    opportunity: '',
  };
}

// Sonnet 4.6 published rates (Jan 2026): $3.00 / 1M input, $15.00 / 1M output.
// Used for logging only — informational, not billed against the user.
function estimateCostUsd(usage) {
  if (!usage) return 0;
  const inp = usage.input_tokens  || 0;
  const out = usage.output_tokens || 0;
  return (inp * 3 + out * 15) / 1_000_000;
}

module.exports = {
  analyzeChange,
  buildFallbackAnalysis,
  AIAnalysisError,
  categorizeAnthropicError,
  tryParseAnalysis,
  estimateCostUsd,
};
