// Taste Gap agent: an LLM tool-use loop over the Qloo tools.
//
// Given our brand, one or two rivals and an optional city, the agent resolves
// the entities, decides which Qloo comparisons to run (independent calls go out
// in parallel, under the client's 10 requests per second spacing), and ends by
// calling submit_brief with a structured brief.
//
// The model runs through src/taste/llm.js, which builds an ordered chain of
// models from LLM_CHAIN (Gemini, a second Gemini model, Groq, OpenRouter and
// Z.ai by default). When a model call fails with a 429, a 5xx or a timeout,
// it is retried once after a backoff; if that fails too, the run moves to the
// next model in the chain for its remaining turns, and each move is recorded
// as a step in the trace.
//
// The model never supplies a score. submit_brief cites rows by ref (e3 for a
// scored entity, c2 for a map cell); assembleBrief() looks each one up in the
// run context and attaches the numbers Qloo actually returned, dropping any
// citation that does not resolve. Model-written text goes through
// sanitizeCopyDeep before it leaves this module (CLAUDE.md no-dash rule).
//
// Limits: MAX_TURNS model calls and a wall-clock timeout (3 minutes by
// default). When either is close, the agent is told to submit with what it
// has and only submit_brief stays available, forced where the provider
// allows it. Every tool call is reported to onStep as it starts and as it
// finishes, for the live trace.

const { sleep, retryAfterMs } = require('../lib/retry');
const { sanitizeCopy, sanitizeCopyDeep } = require('../lib/sanitizeText');
const tools = require('../qloo/tools');
const llm = require('./llm');

const MAX_TURNS = 15;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

// With less than this left, the next turn is the last: submit_brief only.
const WRAP_UP_MS = 45 * 1000;

// Backoff before the one retry on a failed model call. A provider's
// Retry-After wins when it is longer, up to the cap. A retry that would leave
// less than MIN_TURN_MS of the run goes straight to the fallback instead.
const BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const MIN_TURN_MS = 10000;

// Told to a provider with a small input budget (free-tier Groq), so the
// transcript stops growing once the core comparisons are back.
const BUDGET_NOTE = 'This model has a small token budget. Skip optional follow-up calls, and call submit_brief as soon as the core comparisons are back. Keep the brief short: three segments, three win-first items, and one sentence per text field.';

// Row caps tried in turn when a transcript is over a provider's input budget.
const ROW_CAPS = [10, 6, 4, 2];

const SYSTEM_PROMPT = `You are Nivaria's audience analyst. A consumer brand wants to know where a rival's audience is that theirs is not, and which of those audiences to win first. You answer with Qloo taste data only.

Questions to answer:
1. Where is the rival's audience that ours is not? Taste segments in music, film, TV, places and other brands where the rival's audience over-indexes and ours does not.
2. Where on the map? When a city is given, the neighborhoods where the rival's audience outweighs ours, and where we already lead.
3. Which segments should we win first? A ranked list with campaign hooks built from the actual tastes.

How to work:
- In your first turn, call plan with 3 to 4 steps in the order you will run them, each naming the tools it uses, alongside your first lookups in that same turn. Never spend a turn on the plan alone. If the plan has to change (a brand or rival cannot be found, or there is no city), call plan again with the revised steps and a one-sentence reason, alongside your next calls.
- Resolve every brand with search_brands, and the city with find_city when one is given. Pick the brand candidate that matches what the user meant. find_city returns the one city to use. Pass the chosen refs (b1, l1) to the other tools.
- When the user names no rival, find them first: after search_brands for our brand, call discover_rivals with its ref. Its candidates are ranked by the category tags they share with our brand. Pick one or two real competitors: brands in the same category as ours (they share category tags with it) that compete for the same customers. Never pick our own brand or another brand of the same family, its parent company, a brand with the same owner, or a retailer, marketplace or other business that sells it, and do not pick a brand from an unrelated category just because its audience overlaps. Then call choose_rivals with their refs and one sentence on why that cites the affinity and shared tags discover_rivals returned. Use those refs as the rivals for everything that follows.
- Call independent tools in the same turn so they run in parallel. Once the brands are resolved, in one turn, run audience_gap for each rival in artist, movie, tv_show and brand, plus place when there is a city, and brand_positioning.
- In the next turn, call follow_lead once, on the strongest gap across those audience_gap results: the entity with the largest gap that a campaign could be built on (an artist, show, film, brand or venue, never a bar or pub). Call it together with demographic_gap and, with a city, geo_gap. Put any follow-up (such as audience_gap scoped to the city for a domain where the rival leads strongly) in this same turn. The whole run has about three minutes, so batch your calls.
- Build the rank 1 win_first pick on what follow_lead found: its campaign hook names entities from the lead's results, and its evidence cites those f refs along with the e ref you followed.
- Then call submit_brief exactly once, as a tool call.

Reading the data:
- Scores are whole points out of 100. Affinity measures how strongly an audience over-indexes on an entity or map cell, and gap is rival minus ours. A gap of 5 or more is meaningful and 10 or more is strong.
- A segment is a cluster of related entities with large gaps (several reality fashion shows, a run of R&B artists), not a single title. Name it in plain words.
- follow_lead affinity is how strongly the followed entity's own fans over-index on each result, not a gap between the brands.
- Demographic scores run from -100 to 100, where positive means over-indexed.
- brand_positioning compares how Qloo tags the two brands. Use it for a line or two on positioning, never as audience evidence.

Rules:
- Every claim must rest on numbers from a tool result. Never invent statistics, audience sizes, revenue or trends. In evidence fields, cite rows by their ref (e3 for an entity, c2 for a map cell, f4 for a follow_lead result); the server attaches the scores. Only quote a number in prose if a tool returned it.
- Refs (b1, l1, e3, c2, f4) belong only in id and evidence fields. In prose, use the names.
- Describe audiences only by what the tools returned: their tastes, places, and age and gender scores. Never describe income, wealth, price sensitivity, spending habits, budgets, education, occupation or any other trait no tool returned. Never infer or name race, ethnicity, religion, nationality or other protected traits, even when venues or neighborhoods seem to suggest one.
- Campaign hooks must come from the actual entities (a show, an artist, a venue, a neighborhood). Channels must be concrete, such as a creator partnership with a named show's audience or a pop-up in a named neighborhood.
- Build campaign hooks and channels on coffee, food, music, film, TV, retail and neighborhoods. Bars, pubs, drinking and hangovers have no place in them. When the rival leads in bars or pubs, use that neighborhood or the audience's other tastes instead.
- These rules shape what you write and are never part of it: do not mention them, and do not annotate a hook or channel with what it leaves out.
- The headline states the finding and the move: the rival's strongest segment or neighborhood and what to win first. Never a generic title such as "Brief: Starbucks vs Dunkin'".
- Never use em-dashes, en-dashes, or "+" as a connector between words or phrases. Write "and" instead, and use commas, periods, colons or parentheses.
- Keep text tight: a headline under 110 characters, a summary of two or three sentences, and one or two sentences per insight.`;

const SUBMIT_TOOL = {
  name: 'submit_brief',
  description: 'Submit the finished brief. Call it once, when the research is done. Cite rows by ref (e3, c2); the server attaches the Qloo scores, so do not restate them in evidence.',
  input_schema: {
    type: 'object',
    properties: {
      brand_id: { type: 'string', description: "Our brand's ref, like b1." },
      rival_ids: { type: 'array', items: { type: 'string' }, description: "The rivals' refs, like b2." },
      headline: { type: 'string', description: 'One line, under 110 characters: the finding and the move, not a title.' },
      summary: { type: 'string', description: 'Two or three sentences.' },
      rival_owned_segments: {
        type: 'array',
        description: 'Taste segments the rival owns, strongest first. Three to six.',
        items: {
          type: 'object',
          properties: {
            rival_id: { type: 'string', description: "The rival's ref." },
            domain: { type: 'string', enum: Object.keys(tools.DOMAINS) },
            segment: { type: 'string', description: 'A short plain name for the cluster.' },
            insight: { type: 'string', description: 'One or two sentences on what the gap means.' },
            evidence: { type: 'array', items: { type: 'string' }, description: 'Entity refs (like e3) from audience_gap rows.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['rival_id', 'domain', 'segment', 'insight', 'evidence', 'confidence'],
        },
      },
      win_first: {
        type: 'array',
        description: 'Ranked list of what to win first. Three to five. Rank 1 is built on what follow_lead found.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer' },
            segment: { type: 'string' },
            why: { type: 'string' },
            campaign_hook: { type: 'string' },
            channels: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' }, description: 'Entity refs (e3), map cell refs (c2) and follow_lead refs (f4) behind this pick.' },
          },
          required: ['rank', 'segment', 'why', 'campaign_hook', 'channels', 'evidence'],
        },
      },
      geo_hotspots: {
        type: 'array',
        description: 'Map cells worth acting on, from geo_gap. Empty when no city was given.',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'A map cell ref from geo_gap, like c2.' },
            label: { type: 'string', description: 'The place from the geo_gap row, like "Charleston, Staten Island".' },
            note: { type: 'string', description: 'One sentence.' },
          },
          required: ['ref', 'label', 'note'],
        },
      },
      demographic_gap: {
        type: 'array',
        items: {
          type: 'object',
          properties: { rival_id: { type: 'string' }, summary: { type: 'string' } },
          required: ['rival_id', 'summary'],
        },
      },
      positioning: {
        type: 'array',
        items: {
          type: 'object',
          properties: { rival_id: { type: 'string' }, summary: { type: 'string' } },
          required: ['rival_id', 'summary'],
        },
      },
    },
    required: ['brand_id', 'rival_ids', 'headline', 'summary', 'rival_owned_segments', 'win_first'],
  },
};

// The agent's plan, stated in its first turn next to its first lookups so it
// costs no model call. The server keeps it as one trace step and ticks each
// step off once every tool it names has finished (see runTasteAgent).
const PLANNABLE = [...tools.DISCOVERY_DEFS, ...tools.TOOL_DEFS, SUBMIT_TOOL].map(t => t.name);
const PLAN_STEPS = { min: 3, max: 4 };

const PLAN_TOOL = {
  name: 'plan',
  description: 'State your plan for this brief: ' + PLAN_STEPS.min + ' to ' + PLAN_STEPS.max + ' steps in the order you will run them, each with the tools it calls. Call it in your first turn alongside your first lookups, never alone. Call it again only if the plan changes, with the revised steps and why.',
  input_schema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: PLAN_STEPS.min + ' to ' + PLAN_STEPS.max + ' steps.',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'One short sentence in plain words, naming the brands, city or domains.' },
            tools: { type: 'array', items: { type: 'string', enum: PLANNABLE }, description: 'The tools this step calls.' },
          },
          required: ['step', 'tools'],
        },
      },
      reason: { type: 'string', description: 'Only for a revised plan: why it changed, in one sentence.' },
    },
    required: ['steps'],
  },
};

const ALL_TOOLS = [PLAN_TOOL, ...tools.TOOL_DEFS, SUBMIT_TOOL];
// A run with no rival named also gets rival discovery.
const DISCOVERY_TOOLS = [PLAN_TOOL, ...tools.DISCOVERY_DEFS, ...tools.TOOL_DEFS, SUBMIT_TOOL];

const PLAN_NUDGE = 'State your plan: call plan alongside your next calls.';

function userPrompt(brand, rivals, city) {
  return [
    'Our brand: ' + brand,
    rivals.length
      ? 'Rival' + (rivals.length > 1 ? 's' : '') + ': ' + rivals.join(', ')
      : 'Rivals: none given, so find them with discover_rivals and choose_rivals',
    'City: ' + (city || 'none given, so skip place and geo_gap'),
  ].join('\n');
}

// ── Brief assembly ────────────────────────────────────────────────────────────

function findCell(ctx, rivalId, geohash) {
  const pools = rivalId && ctx.geo[rivalId] ? [[rivalId, ctx.geo[rivalId]]] : Object.entries(ctx.geo);
  for (const [rid, g] of pools) {
    const hit = g.hotspots.find(c => c.geohash === geohash)
      || g.our_strongest.find(c => c.geohash === geohash)
      || g.cells.find(c => c.geohash === geohash);
    if (hit) return { rival_id: rid, ...hit };
  }
  return null;
}

// A cited ref (e3, c2, f4) to the Qloo row behind it. Raw entity_ids and
// geohashes are accepted too, so a model that copies an id still resolves.
function resolveCitation(ctx, ref, rivalId) {
  const hit = ctx.refs.get(ref);
  if (hit && hit.kind === 'entity') {
    const item = ctx.gapIndex.get(hit.rival_id + ':' + hit.id);
    if (item) return { kind: 'entity', rival_id: hit.rival_id, ...item };
  }
  if (hit && hit.kind === 'lead') {
    const item = ctx.lead?.index.get(hit.id);
    if (item) return { kind: 'lead', lead: ctx.lead.seed.name, ...item };
  }
  if (hit && hit.kind === 'cell') {
    const cell = findCell(ctx, hit.rival_id, hit.geohash);
    if (cell) return { kind: 'cell', ...cell };
  }
  if (rivalId && ctx.gapIndex.has(rivalId + ':' + ref)) return { kind: 'entity', rival_id: rivalId, ...ctx.gapIndex.get(rivalId + ':' + ref) };
  for (const [key, item] of ctx.gapIndex) {
    if (key.endsWith(':' + ref)) return { kind: 'entity', rival_id: key.slice(0, key.indexOf(':')), ...item };
  }
  const cell = findCell(ctx, rivalId, ref);
  return cell ? { kind: 'cell', ...cell } : null;
}

// Turn submit_brief input into the stored brief: sanitize the prose, then swap
// every citation for the Qloo numbers behind it. Anything that does not
// resolve is dropped and noted in warnings.
//
// Prose clean-up, for what slips past the prompt:
// - A ref in prose, e.g. "Closest taste gap (e31)": drop parenthesised ref
//   lists and bare refs, keep the sentence.
// - A rule echoed back as an aside, e.g. a channel "Creator partnerships (no
//   alcohol angle)": drop a bracketed aside that opens like an instruction
//   ("no", "avoid", "without") or names a rule topic, and drop a channel that
//   is nothing but such an instruction.
// - A raw data key, e.g. "35_to_44" or "tv_show": written out in words.
const REF_IN_PROSE = /\s*\((?:\s*[beclf]\d{1,3}\s*,?)+\)|\b[beclf]\d{1,3}\b/g;

// ── Refs in the model's narration ─────────────────────────────────────────────
// The trace shows what the model says between tool calls, and it thinks in
// refs ("Patagonia is b1", "e31 leads", "c2 (Bushwick)"). Each ref becomes the
// name it stands for in this run: a brand, a city, a scored entity, a map
// cell's place or a follow_lead result. A ref that only labels a name already
// written ("Patagonia is b1", "Patagonia (b1)", "ref b1") is dropped, as is
// any ref the run does not know.
const NOTE_REF = /\b[beclf]\d{1,3}\b/;
const NOTE_REF_LIST = /\s*\((?:\s*(?:refs?\s+)?[beclf]\d{1,3}\s*,?)+\)/gi;
const NOTE_REF_LABEL = /\s+(?:is|=|as)\s+([beclf]\d{1,3})\b/gi;
const NOTE_HAS_REF = /\s+(?:has|with)\s+(?:the\s+)?refs?\s+[beclf]\d{1,3}\b/gi;

function refName(ctx, ref) {
  const hit = ctx.refs.get(ref);
  if (!hit) return null;
  if (hit.kind === 'brand') return tools.entityName(ctx, hit.id);
  if (hit.kind === 'locality') return ctx.localities.get(hit.id)?.name || null;
  if (hit.kind === 'entity') return ctx.gapIndex.get(hit.rival_id + ':' + hit.id)?.name || ctx.entities.get(hit.id)?.name || null;
  if (hit.kind === 'lead') return ctx.lead?.index.get(hit.id)?.name || null;
  if (hit.kind === 'cell') {
    const cell = findCell(ctx, hit.rival_id, hit.geohash);
    return cell ? (cell.label || cell.neighborhood || cell.area || null) : null;
  }
  return null;
}

function nameRefs(ctx, text) {
  if (typeof text !== 'string' || !NOTE_REF.test(text)) return text;
  // Letters and digits only, so "Dunkin" matches the name "Dunkin'".
  const bare = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return text
    // "Patagonia (b1)", "(b1, b2)" and "Patagonia has ref b1": labels for
    // what is already written.
    .replace(NOTE_REF_LIST, '')
    .replace(NOTE_HAS_REF, '')
    // "Patagonia is b1": drop the label when the name just before it is the
    // ref's own; otherwise ("the closest is b4") keep the sentence, named.
    .replace(NOTE_REF_LABEL, (m, ref, offset, all) => {
      const name = refName(ctx, ref);
      const before = bare(all.slice(Math.max(0, offset - 80), offset));
      if (!name || before.endsWith(bare(name))) return '';
      return m.slice(0, m.length - ref.length) + name;
    })
    .replace(/\brefs?\s+(?=[beclf]\d{1,3}\b)/gi, '')
    .replace(/\b[beclf]\d{1,3}\b/g, ref => refName(ctx, ref) || '')
    // Tidy what a removal leaves behind.
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,?\s+(?:and|or)(?=[.;:!?]|$)/gi, '')
    .replace(/([,;:])(?=[,.;:])/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
const RULE_START = /^\s*(no|not|never|avoid\w*|without|excluding|non)\b/i;
const RULE_TOPIC = /\b(alcohol\w*|hangovers?|drinking|angle|rules?|instructions?|guidelines?|prompt|compliant)\b/i;
const ASIDE = /\s*[([]([^()[\]]*)[)\]]/g;

const isRuleEcho = s => RULE_START.test(s) || RULE_TOPIC.test(s);

function humanizeKeys(s) {
  return s
    .replace(/\b(\d+)_to_(\d+)\b/g, '$1 to $2')
    .replace(/\b(\d+)_and_(younger|older)\b/g, '$1 and $2')
    .replace(/\btv_shows?\b/gi, 'TV')
    .replace(/\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/g, m => m.replace(/_/g, ' '));
}

function cleanProse(s) {
  if (typeof s !== 'string') return s;
  return humanizeKeys(s.replace(REF_IN_PROSE, '').replace(ASIDE, (m, inner) => (isRuleEcho(inner) ? '' : m)))
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Channel tags in sentence case: the first letter capitalized, and a tag the
// model wrote in Title Case ("Out of Home Billboards") lowered word by word,
// except names Qloo returned in this run (Staten Island, Florida Georgia Line),
// platform names, and words with capitals inside them (TV, TikTok).
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const PLATFORMS = new Set(['Instagram', 'Spotify', 'Pandora', 'Snapchat', 'Pinterest', 'Reddit', 'Twitch', 'Facebook', 'Hulu', 'Netflix', 'Google', 'Apple', 'Amazon', 'Discord', 'Uber', 'Yelp']);

function sentenceCase(tag, names) {
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const words = tag.split(' ');
  const big = words.filter(w => /^[a-z]/i.test(w) && !SMALL_WORDS.has(w.toLowerCase()));
  if (words.length < 2 || big.length < 2 || !big.every(w => /^[A-Z]/.test(w))) return cap(tag);
  // Character spans covered by a whole known name, matched as a phrase.
  const spans = [];
  for (const n of names) {
    for (let i = tag.indexOf(n); i !== -1; i = tag.indexOf(n, i + n.length)) spans.push([i, i + n.length]);
  }
  let pos = 0;
  return cap(words.map((w, i) => {
    const at = tag.indexOf(w, pos);
    pos = at + w.length;
    const inName = spans.some(([a, z]) => at >= a && pos <= z);
    return i === 0 || inName || PLATFORMS.has(w) || /[A-Z]/.test(w.slice(1)) ? w : w.toLowerCase();
  }).join(' '));
}

// Every name this run saw (brands, entities, places, cities, map labels), for
// sentenceCase to leave as written.
function knownNames(ctx) {
  const names = new Set();
  const add = n => { if (typeof n === 'string' && n.trim().length > 1) names.add(n.trim()); };
  for (const e of ctx.entities.values()) add(e.name);
  for (const l of ctx.localities.values()) add(l.name);
  for (const domains of Object.values(ctx.gaps)) {
    for (const items of Object.values(domains)) for (const it of items) { add(it.name); add(it.neighborhood); }
  }
  for (const g of Object.values(ctx.geo)) {
    for (const c of [...g.hotspots, ...g.our_strongest]) {
      add(c.neighborhood); add(c.area);
      for (const p of c.top_places || []) add(p);
    }
  }
  for (const it of ctx.lead?.index.values() || []) { add(it.name); add(it.neighborhood); }
  return [...names];
}

// Traits no Qloo tool returns (income, class, education). The prompt forbids
// them; as a backstop, a sentence that names one is dropped, the run's
// warnings name the trait, and the server log keeps the sentence.
// "budget" only counts when it describes people ("budget-conscious", "on a
// budget", "budget shoppers"); a marketing sentence such as "shift media
// budget" or "a budget-friendly pop-up" stays.
const BUDGET_AUDIENCE = 'budget[- ](?:conscious|minded|savvy|sensitive|oriented|focused|constrained)'
  + '|(?:on|stick(?:s|ing)? to) (?:a|their) (?:tight |limited |strict |small |shoestring )?budget'
  + '|budget[- ](?:shoppers?|consumers?|buyers?|customers?|fans?|audiences?|crowds?|segments?|households?|travell?ers?|famil(?:y|ies)|students?|diners?|spenders?)';
const UNSUPPORTED_TRAIT = new RegExp('\\b(?:price[- ]?sensitiv(?:e|ity)|' + BUDGET_AUDIENCE
  + '|affluen(?:t|ce)|wealth(?:y|ier|iest)|(?:low|lower|middle|high|higher)[- ]income|blue[- ]collar|white[- ]collar)\\b|educated\\b', 'i');

// A sentence ends at . ! or ? followed by a space and a capital or digit, but
// not after a short abbreviation ("St." in "St. Marks Place").
const SENTENCE_BREAK = /(?<!\b(?:St|Mt|Mr|Mrs|Ms|Dr|Jr|Sr|vs|Ave)\.)(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/;

function dropTraitSentences(text, where, warnings) {
  if (typeof text !== 'string' || !UNSUPPORTED_TRAIT.test(text)) return text;
  return text.split(SENTENCE_BREAK).filter(sentence => {
    const hit = UNSUPPORTED_TRAIT.exec(sentence);
    if (!hit) return true;
    warnings.push('Removed a sentence that described a trait no tool returned ("' + hit[0] + '")');
    console.warn('[taste] dropped a sentence with an unsupported trait ("' + hit[0] + '") from ' + where + ': ' + sentence.slice(0, 200));
    return false;
  }).join(' ').trim();
}

function cleanBriefProse(b, ctx, warnings) {
  const names = knownNames(ctx);
  const prose = (obj, where) => {
    for (const k of ['headline', 'summary', 'segment', 'insight', 'why', 'campaign_hook', 'label', 'note']) {
      if (typeof obj[k] !== 'string') continue;
      const had = obj[k].trim() !== '';
      obj[k] = dropTraitSentences(cleanProse(obj[k]), where + k, warnings);
      if (k === 'segment' && had && !obj[k]) obj.traitOnly = true;
    }
    if (Array.isArray(obj.channels)) {
      obj.channels = obj.channels
        .map(c => dropTraitSentences(cleanProse(c), where + 'channels', warnings))
        .filter(c => typeof c === 'string' && c && !(RULE_START.test(c) && RULE_TOPIC.test(c)))
        .map(c => sentenceCase(c, names));
    }
  };
  prose(b, '');
  for (const k of ['rival_owned_segments', 'win_first', 'geo_hotspots', 'demographic_gap', 'positioning']) {
    (b[k] || []).forEach((item, i) => prose(item, k + '[' + i + '].'));
  }
  // A segment whose whole name was an unsupported trait has nothing left to
  // stand on, so the segment or win-first pick goes too.
  for (const k of ['rival_owned_segments', 'win_first']) {
    if (!Array.isArray(b[k])) continue;
    b[k] = b[k].filter(item => {
      if (!item.traitOnly) return true;
      warnings.push(k === 'win_first' ? 'Removed a win-first pick named after that trait' : 'Removed a segment named after that trait');
      return false;
    });
  }
  return b;
}

// The headline when the clean-up left none: the top segment, plainly.
function fallbackHeadline(ctx, segments, brandId, rivalIds) {
  const brand = brandId ? tools.entityName(ctx, brandId) : 'us';
  const top = segments[0];
  if (top) return sanitizeCopy(tools.entityName(ctx, top.rival_id) + ' leads ' + brand + ' in ' + top.segment);
  return sanitizeCopy('Where ' + rivalIds.map(id => tools.entityName(ctx, id)).join(' and ') + ' leads ' + brand);
}

// When the model cites no hotspot for a rival whose city was mapped, the
// brief still lists the cells where that rival leads most, straight from
// geo_gap: labelled cells first, then by gap.
const FALLBACK_HOTSPOTS = 5;

function serverHotspots(ctx, rivalId, brandId) {
  const g = ctx.geo[rivalId];
  if (!g) return [];
  const rival = tools.entityName(ctx, rivalId);
  const ours = brandId ? tools.entityName(ctx, brandId) : 'we';
  const pick = [...g.hotspots.filter(c => c.label), ...g.hotspots.filter(c => !c.label)].slice(0, FALLBACK_HOTSPOTS);
  return pick.map(c => ({
    kind: 'cell', rival_id: rivalId, ...c,
    note: sanitizeCopy(rival + ' scores ' + Math.round(c.rival_affinity * 100) + ' here and ' + ours + ' scores ' + Math.round(c.our_affinity * 100) + '.'),
  }));
}

// Distinct Qloo-scored items the brief cites (entities, map cells and
// follow_lead results), each shown with the numbers the server attached.
function countDataPoints(brief) {
  const keys = new Set();
  const add = e => keys.add(e.kind === 'cell' ? 'c:' + (e.rival_id || '') + ':' + e.geohash
    : e.kind === 'lead' ? 'f:' + e.entity_id : 'e:' + (e.rival_id || '') + ':' + e.entity_id);
  for (const s of brief.rival_owned_segments) s.evidence.forEach(add);
  for (const w of brief.win_first) w.evidence.forEach(add);
  for (const h of brief.geo_hotspots) add({ ...h, kind: 'cell' });
  return keys.size;
}

function assembleBrief(raw, ctx, warnings) {
  const b = cleanBriefProse(sanitizeCopyDeep(raw), ctx, warnings);
  let dropped = 0;
  const brandId = tools.brandId(ctx, b.brand_id);
  const rivalIds = (b.rival_ids || []).map(r => tools.brandId(ctx, r)).filter(Boolean);
  const brandRef = id => ({ entity_id: id, name: tools.entityName(ctx, id), image: ctx.entities.get(id)?.image || null });

  // A follow_lead result is evidence for a win-first pick only: it is one
  // audience's taste, not a gap between the brands.
  const evidenceFor = (refs, rivalId, where, { lead = false } = {}) => {
    const out = [];
    for (const ref of refs || []) {
      const hit = resolveCitation(ctx, ref, rivalId);
      if (hit && hit.kind === 'lead' && !lead) { dropped += 1; warnings.push('Dropped follow_lead citation ' + ref + ' in ' + where + ', which needs a gap between the brands'); }
      else if (hit) out.push(hit);
      else { dropped += 1; warnings.push('Dropped unresolved citation ' + ref + ' in ' + where); }
    }
    return out;
  };

  const segments = [];
  for (const s of b.rival_owned_segments || []) {
    const rivalId = tools.brandId(ctx, s.rival_id);
    const evidence = evidenceFor(s.evidence, rivalId, 'segment "' + s.segment + '"');
    if (!evidence.length) { warnings.push('Dropped segment "' + s.segment + '" with no resolvable evidence'); continue; }
    segments.push({ ...s, rival_id: rivalId || evidence[0].rival_id, evidence });
  }

  const winFirst = (b.win_first || [])
    .map(w => ({ ...w, evidence: evidenceFor(w.evidence, null, 'win_first "' + w.segment + '"', { lead: true }) }))
    .sort((x, y) => (x.rank || 0) - (y.rank || 0))
    .map((w, i) => ({ ...w, rank: i + 1 }));

  // The "Lead followed" note goes under the pick built on follow_lead (the
  // first that cites its results), with the followed entity's gap and the
  // results the pick cites, all as Qloo returned them.
  if (ctx.lead) {
    const w = winFirst.find(x => x.evidence.some(e => e.kind === 'lead'));
    if (w) {
      const { ref, ...seed } = ctx.lead.seed;
      w.lead = {
        ...seed,
        found: w.evidence.filter(e => e.kind === 'lead').map(e => ({ entity_id: e.entity_id, name: e.name, domain: e.domain, affinity: e.affinity })),
      };
    } else {
      warnings.push('The agent followed the lead on ' + ctx.lead.seed.name + ' but built no win-first pick on it');
    }
  }

  const hotspots = [];
  for (const h of b.geo_hotspots || []) {
    const hit = resolveCitation(ctx, h.ref || h.geohash, null);
    if (!hit || hit.kind !== 'cell') { dropped += 1; warnings.push('Dropped hotspot ' + (h.ref || h.geohash)); continue; }
    // The cell's own "neighborhood, borough" label wins over the model's wording.
    hotspots.push({ ...hit, label: hit.label || h.label, note: h.note });
  }
  for (const rivalId of Object.keys(ctx.geo)) {
    if (hotspots.some(h => h.rival_id === rivalId)) continue;
    const filled = serverHotspots(ctx, rivalId, brandId);
    if (filled.length) warnings.push('The brief named no hotspots for ' + tools.entityName(ctx, rivalId) + ', so the map lists the cells where it leads most');
    hotspots.push(...filled);
  }

  const perRival = (arr, source) => (arr || [])
    .map(x => ({ ...x, rival_id: tools.brandId(ctx, x.rival_id) }))
    .filter(x => x.rival_id && source[x.rival_id])
    .map(x => ({ rival_id: x.rival_id, summary: x.summary, ...source[x.rival_id] }));

  const brief = {
    brand: brandId ? brandRef(brandId) : null,
    rivals: rivalIds.map(brandRef),
    headline: b.headline || fallbackHeadline(ctx, segments, brandId, rivalIds),
    summary: b.summary || '',
    rival_owned_segments: segments,
    win_first: winFirst,
    geo_hotspots: hotspots,
    demographic_gap: perRival(b.demographic_gap, ctx.demographics),
    positioning: perRival(b.positioning, ctx.positioning),
  };
  // Rival discovery: every candidate the agent considered, which it picked and
  // why, straight from discover_rivals and choose_rivals.
  if (ctx.discovery && ctx.rivalChoice) {
    brief.rival_choice = {
      reason: dropTraitSentences(cleanProse(ctx.rivalChoice.reason), 'rival_choice.reason', warnings),
      category: ctx.discovery.category,
      candidates: ctx.discovery.candidates.map(c => ({
        entity_id: c.entity_id,
        name: c.name,
        image: ctx.entities.get(c.entity_id)?.image || null,
        affinity: c.affinity,
        popularity: c.popularity,
        shared_tags: c.shared_tags.slice(0, 5),
        category: c.category,
        found_by: c.found_by,
        flags: c.flags,
        picked: ctx.rivalChoice.picked.includes(c.entity_id),
      })),
    };
  }
  // How the numbers were checked: citations resolved against this run's Qloo
  // results, and those that could not be (runTasteAgent adds the rest).
  brief.provenance = { data_points: countDataPoints(brief), dropped };
  return brief;
}

// Everything the UI charts, straight from Qloo: gaps per domain, the full
// heatmap join for the map, demographics and positioning, keyed by rival.
function chartData(ctx) {
  const geo = {};
  for (const [rid, g] of Object.entries(ctx.geo)) {
    // hotspots: geo_gap's labelled cells where the rival leads most, so the UI
    // can number them even when a brief lists none.
    geo[rid] = { locality: g.locality, stats: g.stats, cells: g.cells, hotspots: g.hotspots };
  }
  return { gaps: ctx.gaps, geo, demographics: ctx.demographics, positioning: ctx.positioning };
}

function checkBrief(input, ctx) {
  const problems = [];
  if (!input || typeof input !== 'object') return ['submit_brief input must be an object.'];
  if (!tools.brandId(ctx, input.brand_id)) problems.push('brand_id must be a brand ref from search_brands, like b1.');
  const rivals = Array.isArray(input.rival_ids) ? input.rival_ids : [];
  if (!rivals.length || rivals.some(r => !tools.brandId(ctx, r))) problems.push('rival_ids must be brand refs from search_brands, like b2.');
  for (const k of ['headline', 'summary']) if (!input[k] || typeof input[k] !== 'string') problems.push(k + ' is required.');
  if (!Array.isArray(input.rival_owned_segments) || !input.rival_owned_segments.length) problems.push('rival_owned_segments needs at least one segment.');
  if (!Array.isArray(input.win_first) || !input.win_first.length) problems.push('win_first needs at least one item.');
  return problems;
}

// ── Loop ──────────────────────────────────────────────────────────────────────

// For a provider with an input budget, a copy of the transcript whose tool
// results keep fewer rows, tightening until the estimate fits. Rows arrive
// strongest first, so the weakest go first, and the server still holds every
// row, so earlier citations keep resolving.
function trimResult(content, cap) {
  let obj;
  try { obj = JSON.parse(content); } catch (_) { return content; }
  let changed = false;
  for (const k of ['rows', 'rival_hotspots']) {
    if (Array.isArray(obj[k]) && obj[k].length > cap) { obj[k] = obj[k].slice(0, cap); changed = true; }
  }
  return changed ? JSON.stringify(obj) : content;
}

function fitTranscript(system, transcript, toolDefs, budget) {
  if (!budget || llm.estimateTokens(system, transcript, toolDefs) <= budget) return transcript;
  let view = transcript;
  for (const cap of ROW_CAPS) {
    view = transcript.map(t => (t.role === 'tool'
      ? { ...t, results: t.results.map(r => ({ ...r, content: trimResult(r.content, cap) })) }
      : t));
    if (llm.estimateTokens(system, view, toolDefs) <= budget) break;
  }
  return view;
}

function addUsage(total, u) {
  if (!u) return;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    total[k] += u[k] || 0;
  }
}

const emptyUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

// ── Privacy ───────────────────────────────────────────────────────────────────
// Prompts go to third-party model APIs, some on free tiers that may keep them.
// So the only outside input that reaches a prompt is the three strings typed
// for this run: brand, rivals and city. runTasteAgent takes nothing else (no
// user, workspace, email or business context), this module and the tools it
// calls never touch the database or session, and the strings are capped,
// stripped of control characters and scrubbed of anything shaped like an
// email address or phone number before use. test-taste-privacy.js checks all
// three.
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE_LIKE = /\+?\d[\d\s().-]{6,}\d/g;
const INPUT_MAX = 80;

function cleanInput(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(EMAIL_LIKE, ' ')
    .replace(PHONE_LIKE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, INPUT_MAX);
}

// chain: an optional chain spec in LLM_CHAIN syntax for this run only.
async function runTasteAgent({ brand, rivals, city, onStep, timeoutMs = DEFAULT_TIMEOUT_MS, chain: chainSpec } = {}) {
  const brandName = cleanInput(brand);
  const rivalNames = (Array.isArray(rivals) ? rivals : [rivals]).map(cleanInput).filter(Boolean);
  if (!brandName) throw new Error('brand is required');
  if (rivalNames.length > 2) throw new Error('give at most two rivals');
  // No rival named: the agent finds them (discover_rivals, choose_rivals).
  const discovery = rivalNames.length === 0;
  const cityName = cleanInput(city);

  const chain = llm.buildChain(chainSpec);
  let link = 0;
  let provider = llm.createProvider(chain[0]);
  let budgetNoted = Boolean(provider.inputBudget);

  const ctx = tools.createContext();
  const steps = [];
  const warnings = [];
  const usage = emptyUsage();
  const providers = [];  // [{ key, provider, model, turns, usage }] in the order they ran
  const started = Date.now();
  const deadline = started + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const emit = step => { try { onStep?.({ ...step }); } catch (_) {} };
  const openStep = fields => {
    const step = { n: steps.length + 1, status: 'running', at_ms: Date.now() - started, ...fields };
    steps.push(step);
    emit(step);
    return step;
  };
  const closeStep = (step, fields) => {
    Object.assign(step, fields, { ms: Date.now() - started - step.at_ms });
    emit(step);
  };

  // The plan: one trace step (kind "plan") holding the agent's current plan,
  // re-emitted as it changes. A plan step ticks off once every tool it names
  // has succeeded in this run and none of them is still running; a step that
  // names no tool ticks with a later one. A revision restates the plan, so its
  // steps that already ran tick at once, and says why in a step of its own.
  // When the brief is in, a step whose tools never ran is marked skipped.
  let plan = null;           // { step }
  const toolRuns = {};       // tool name -> { running, finished }
  const runsOf = name => (toolRuns[name] = toolRuns[name] || { running: 0, finished: 0 });

  const tickPlan = (final = false) => {
    if (!plan) return;
    let changed = false;
    const items = plan.step.items;
    const ran = t => runsOf(t).finished > 0;
    const set = (item, status) => { item.status = status; changed = true; };
    for (const item of items) {
      if (item.status !== 'pending' || !item.tools.length) continue;
      if (item.tools.every(t => ran(t) && !runsOf(t).running)) set(item, 'done');
      else if (final) set(item, item.tools.some(ran) ? 'done' : 'skipped');
    }
    items.forEach((item, i) => {
      if (item.status !== 'pending' || item.tools.length) return;
      const later = items.slice(i + 1).some(x => x.status === 'done');
      if (later || final) set(item, later ? 'done' : 'skipped');
    });
    if (changed) emit(plan.step);
  };

  const setPlan = input => {
    const clean = s => sanitizeCopy(nameRefs(ctx, String(s || '')).trim());
    const cap = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n - 3) > 0 ? s.lastIndexOf(' ', n - 3) : n - 3).replace(/[,;:]$/, '') + '...');
    const items = (Array.isArray(input?.steps) ? input.steps : []).map(s => ({
      text: cap(clean(s?.step), 160),
      tools: [...new Set((Array.isArray(s?.tools) ? s.tools : []).filter(t => PLANNABLE.includes(t)))],
      status: 'pending',
    })).filter(s => s.text);
    if (items.length < PLAN_STEPS.min || items.length > PLAN_STEPS.max) {
      return { error: 'Give ' + PLAN_STEPS.min + ' to ' + PLAN_STEPS.max + ' steps, each with the tools it calls.' };
    }
    if (!plan) {
      plan = { step: openStep({ kind: 'plan', label: 'Plan', items, revisions: 0 }) };
    } else {
      const reason = cap(clean(input.reason), 240);
      if (!reason) return { error: 'A revised plan needs a reason: say in one sentence why the plan changed.' };
      const done = new Set(plan.step.items.filter(x => x.status === 'done').map(x => x.text.toLowerCase()));
      for (const it of items) if (done.has(it.text.toLowerCase())) it.status = 'done';
      Object.assign(plan.step, { items, revisions: plan.step.revisions + 1, reason });
      closeStep(openStep({ kind: 'replan', label: 'Plan changed: ' + reason }), { status: 'done' });
      emit(plan.step);
    }
    tickPlan();
    return { content: plan.step.revisions ? 'Revised plan noted. Carry it out.' : 'Plan noted. Carry it out, and call plan again only if it changes.' };
  };

  // One model turn on the current chain entry. A transient failure (429, 5xx,
  // timeout) gets one backoff retry; if that fails, or the entry cannot work
  // at all (bad key, unknown model), the run moves to the next entry for the
  // rest of the run. A wait longer than MAX_BACKOFF_MS (a spent daily quota)
  // cannot clear inside the run, so it moves on without waiting.
  const callModel = async request => {
    for (;;) {
      let failure = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 1000) throw Object.assign(new Error('deadline'), { aborted: true });
        try {
          return await provider.complete({
            ...request,
            transcript: fitTranscript(request.system, request.transcript, request.tools, provider.inputBudget),
            signal: controller.signal,
            timeoutMs: Math.min(provider.timeoutMs, remaining),
          });
        } catch (err) {
          if (err.aborted || controller.signal.aborted) throw err;
          const verdict = llm.classifyFailure(err);
          if (!verdict) throw err;
          failure = { err, why: verdict.why };
          if (verdict.action === 'skip' || attempt === 2) break;
          const suggested = err.retryAfterMs ?? retryAfterMs(err);
          if (suggested != null && suggested > MAX_BACKOFF_MS) break;
          const wait = Math.max(BACKOFF_MS, suggested || 0);
          if (deadline - Date.now() - wait < MIN_TURN_MS) break;
          console.warn('[taste] ' + provider.label + ' ' + verdict.why + ', retrying in ' + wait + 'ms');
          await sleep(wait);
        }
      }
      if (link + 1 >= chain.length) {
        // Every model in the chain failed; callers read this (and the status)
        // to tell a spent quota from a bad run.
        failure.err.chainExhausted = true;
        throw failure.err;
      }
      const from = provider;
      link += 1;
      provider = llm.createProvider(chain[link]);
      const step = openStep({
        kind: 'switch', from: from.key, to: provider.key,
        label: 'Switching from ' + from.label + ' to ' + provider.label + ' after a ' + failure.why,
      });
      closeStep(step, { status: 'done', summary: failure.err.message.slice(0, 200) });
      if (provider.inputBudget && !budgetNoted) {
        budgetNoted = true;
        request.transcript.push({ role: 'user', text: BUDGET_NOTE });
      }
    }
  };

  // Provider call ids, made safe for every provider's id rules and unique
  // across the run (a fallback provider sees the whole transcript).
  const seenIds = new Set();
  const callId = (raw, turn, i) => {
    const base = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'call_' + turn + '_' + i;
    let id = base;
    for (let n = 2; seenIds.has(id); n += 1) id = base + '_' + n;
    seenIds.add(id);
    return id;
  };

  const opening = userPrompt(brandName, rivalNames, cityName);
  const transcript = [{ role: 'user', text: provider.inputBudget ? opening + '\n\n' + BUDGET_NOTE : opening }];
  let submitted = null;
  let turns = 0;
  let wrapUp = false;

  try {
    while (!submitted) {
      if (turns >= MAX_TURNS) throw new Error('The agent used all ' + MAX_TURNS + ' turns without submitting a brief');
      turns += 1;
      if (!wrapUp && (turns === MAX_TURNS || deadline - Date.now() < WRAP_UP_MS)) {
        wrapUp = true;
        transcript.push({ role: 'user', text: 'Time is almost up. Call submit_brief now with what you have.' });
      }

      const res = await callModel({
        system: SYSTEM_PROMPT,
        transcript,
        tools: wrapUp ? [SUBMIT_TOOL] : discovery ? DISCOVERY_TOOLS : ALL_TOOLS,
        finalOnly: wrapUp,
      });
      addUsage(usage, res.usage);
      let used = providers[providers.length - 1];
      if (!used || used.key !== provider.key) {
        used = { key: provider.key, provider: provider.name, model: provider.model, turns: 0, usage: emptyUsage() };
        providers.push(used);
      }
      used.turns += 1;
      addUsage(used.usage, res.usage);

      const calls = res.calls.map((c, i) => ({ ...c, id: callId(c.id, turns, i) }));
      transcript.push({ role: 'assistant', source: provider.key, text: res.text, calls, native: res.native });

      if (res.stopReason === 'refusal') throw new Error('The model declined this request');

      // Narration between tool calls goes to the trace as a note.
      if (res.text) {
        const note = openStep({ kind: 'note', label: sanitizeCopy(nameRefs(ctx, res.text)) });
        closeStep(note, { status: 'done' });
      }

      if (!calls.length) {
        transcript.push({ role: 'user', text: res.stopReason === 'max_tokens'
          ? 'Your reply was cut off. Call submit_brief with a shorter brief.'
          : 'Call submit_brief with the finished brief rather than replying in text.' });
        continue;
      }

      const results = await Promise.all(calls.map(async call => {
        // The plan is kept by the loop, not run as a tool, and has no step of its own.
        if (call.name === 'plan') {
          const out = call.inputError ? { error: call.inputError } : setPlan(call.input);
          return out.error ? { id: call.id, name: call.name, isError: true, content: out.error } : { id: call.id, name: call.name, content: out.content };
        }
        const isSubmit = call.name === 'submit_brief';
        const step = openStep({
          kind: 'tool', tool: call.name, turn: turns, ...(isSubmit ? {} : { input: call.input }),
          label: isSubmit ? 'Writing the brief with ' + provider.label : tools.describeCall(ctx, call.name, call.input),
        });
        if (call.inputError) {
          closeStep(step, { status: 'error', summary: call.inputError });
          return { id: call.id, name: call.name, isError: true, content: call.inputError };
        }
        if (isSubmit) {
          // With discovery, the brief is about the rivals the agent chose.
          if (discovery && ctx.rivalChoice && call.input && typeof call.input === 'object') {
            call.input.rival_ids = ctx.rivalChoice.picked.map(id => ctx.discovery.candidates.find(c => c.entity_id === id).ref);
          }
          const problems = discovery && !ctx.rivalChoice
            ? ['Find the rivals first: call discover_rivals, then choose_rivals, then run the comparisons.']
            : checkBrief(call.input, ctx);
          if (problems.length) {
            closeStep(step, { status: 'error', summary: problems.join(' ') });
            return { id: call.id, name: call.name, isError: true, content: problems.join(' ') };
          }
          submitted = call.input;
          closeStep(step, { status: 'done', summary: 'Brief submitted' });
          runsOf(call.name).finished += 1;
          tickPlan();
          return { id: call.id, name: call.name, content: 'Brief received.' };
        }
        runsOf(call.name).running += 1;
        const out = await tools.executeTool(ctx, call.name, call.input);
        runsOf(call.name).running -= 1;
        if (out.ok) runsOf(call.name).finished += 1;
        closeStep(step, { status: out.ok ? 'done' : 'error', summary: out.ok ? out.summary : out.error });
        tickPlan();
        return out.ok
          ? { id: call.id, name: call.name, content: JSON.stringify(out.result) }
          : { id: call.id, name: call.name, isError: true, content: out.error };
      }));
      // All results for one turn go back together.
      transcript.push({ role: 'tool', results });
      // No plan in the first turn: ask for it with the next calls, which
      // costs no extra turn.
      if (turns === 1 && !plan && !submitted) transcript.push({ role: 'user', text: PLAN_NUDGE });
    }
  } catch (err) {
    if (plan) closeStep(plan.step, { status: 'error' });
    const timedOut = controller.signal.aborted || err.aborted;
    const e = new Error(timedOut ? 'The agent ran out of time before writing the brief' : err.message);
    e.steps = steps;
    e.usage = usage;
    e.providers = providers;
    e.timedOut = timedOut;
    e.chainExhausted = Boolean(err.chainExhausted);
    e.status = err.status ?? null;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (plan) {
    tickPlan(true);
    closeStep(plan.step, { status: 'done' });
  }
  const brief = assembleBrief(submitted, ctx, warnings);
  // The rest of the provenance: the Qloo endpoints this run called, with
  // counts, and the model that wrote the brief (the last one used).
  const writer = providers[providers.length - 1];
  brief.provenance = {
    ...brief.provenance,
    endpoints: tools.endpointsUsed(ctx),
    qloo_calls: Object.values(ctx.calls).reduce((n, c) => n + c, 0),
    tool_calls: steps.filter(s => s.kind === 'tool' && s.tool !== 'submit_brief').length,
    turns,
    duration_ms: Date.now() - started,
    written_by: writer ? { provider: writer.provider, label: llm.PROVIDERS[writer.provider]?.label || writer.provider, model: writer.model } : null,
  };
  return {
    brief,
    data: chartData(ctx),
    steps,
    warnings,
    usage,
    providers,
    model: providers.map(p => p.provider + ':' + p.model).join(' then '),
    turns,
    duration_ms: Date.now() - started,
    input: {
      brand: brandName,
      rivals: discovery ? ctx.rivalChoice.picked.map(id => tools.entityName(ctx, id)) : rivalNames,
      city: cityName || null,
      discovered: discovery,
    },
  };
}

module.exports = { runTasteAgent, cleanInput, userPrompt, assembleBrief, nameRefs, SYSTEM_PROMPT };
