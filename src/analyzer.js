const Anthropic = require('@anthropic-ai/sdk');

let client;

function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

async function analyzeChange(competitor, before, after, diff) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return buildFallbackAnalysis(competitor, diff);
  }

  const prompt = buildPrompt(competitor, diff);

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: 'You are a competitive intelligence analyst. You analyze competitor website changes and produce structured battle card intelligence. Always respond with valid JSON only, no markdown fences.',
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI response was not valid JSON');

  return JSON.parse(jsonMatch[0]);
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

module.exports = { analyzeChange };
