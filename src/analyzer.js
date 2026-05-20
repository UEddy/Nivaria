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

async function analyzeChange(competitor, before, after, diff) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return buildFallbackAnalysis(competitor, diff);
  }

  const prompt = buildPrompt(competitor, diff);

  let response;
  try {
    response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: 'You are a competitive intelligence analyst. You analyze competitor website changes and produce structured battle card intelligence. Always respond with valid JSON only, no markdown fences.',
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    throw categorizeAnthropicError(err);
  }

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new AIAnalysisError('ai_invalid_response', 'AI response was not valid JSON', null);
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new AIAnalysisError('ai_invalid_response', `AI response JSON parse failed: ${err.message}`, err);
  }
}

function buildPrompt(competitor, diff) {
  return `A competitor's web page has changed. Analyze what changed and produce competitive intelligence.

Competitor: ${competitor.name}
URL: ${competitor.url}
${competitor.description ? `Internal context: ${competitor.description}` : ''}

CHANGES DETECTED:
Page title: "${diff.beforeTitle}" → "${diff.afterTitle}"
Meta description: "${diff.beforeMeta}" → "${diff.afterMeta}"

Previous headings: ${diff.beforeHeadings.slice(0, 20).join(' | ')}
Current headings:  ${diff.afterHeadings.slice(0, 20).join(' | ')}

Previous pricing section: ${diff.beforePricing.substring(0, 2000) || 'N/A'}
Current pricing section:  ${diff.afterPricing.substring(0, 2000) || 'N/A'}

Previous features section: ${diff.beforeFeatures.substring(0, 1500) || 'N/A'}
Current features section:  ${diff.afterFeatures.substring(0, 1500) || 'N/A'}

Notable new words/phrases: ${diff.added.slice(0, 40).join(', ')}
Removed words/phrases: ${diff.removed.slice(0, 40).join(', ')}

Respond with ONLY this JSON structure:
{
  "headline": "One punchy sentence describing the most important change (max 100 chars)",
  "summary": "2-3 sentence competitive analysis of what changed and why it matters",
  "threat_level": "low|medium|high",
  "threat_reasoning": "1-2 sentences explaining the threat assessment",
  "recommended_response": "Specific, actionable response for the sales/product team",
  "talking_points": [
    "Sales talking point 1",
    "Sales talking point 2",
    "Sales talking point 3",
    "Sales talking point 4"
  ],
  "key_changes": [
    {
      "category": "pricing|features|positioning|messaging|partnership|other",
      "description": "What specifically changed",
      "impact": "Why this matters to us"
    }
  ],
  "opportunity": "Any opportunity this creates for our company"
}`;
}

function buildFallbackAnalysis(competitor, diff) {
  const hasHeadingChanges = diff.afterHeadings.some(h => !diff.beforeHeadings.includes(h));
  const hasPricingChanges = diff.afterPricing !== diff.beforePricing;
  const threatLevel = hasPricingChanges ? 'medium' : 'low';

  return {
    headline: `${competitor.name} updated their website content`,
    summary: `Changes detected on ${competitor.url}. ${hasPricingChanges ? 'Pricing section was modified.' : ''} ${hasHeadingChanges ? 'Page structure and headings changed.' : ''} Enable ANTHROPIC_API_KEY for detailed AI analysis.`,
    threat_level: threatLevel,
    threat_reasoning: 'Automated detection without AI analysis — threat level is estimated.',
    recommended_response: 'Review the competitor page manually and enable AI analysis for detailed intelligence.',
    talking_points: ['Competitor made updates — manual review recommended'],
    key_changes: [{ category: 'other', description: 'Page content changed', impact: 'Requires manual review' }],
    opportunity: 'Review changes to identify opportunities.',
  };
}

module.exports = { analyzeChange, buildFallbackAnalysis, AIAnalysisError, categorizeAnthropicError };
