// Taste Gap agent: a Claude tool-use loop over the Qloo tools.
//
// Given our brand, one or two rivals and an optional city, the agent resolves
// the entities, decides which Qloo comparisons to run (independent calls go out
// in parallel, under the client's 10 requests per second spacing), and ends by
// calling submit_brief with a structured brief.
//
// The model never supplies a score. submit_brief cites entities by entity_id
// and map cells by geohash; assembleBrief() looks each one up in the run
// context and attaches the numbers Qloo actually returned, dropping any
// citation that does not resolve. Model-written text goes through
// sanitizeCopyDeep before it leaves this module (CLAUDE.md no-dash rule).
//
// Limits: MAX_TURNS model calls and a wall-clock timeout (3 minutes by
// default). When either is close, the agent is told to submit with what it
// has and only submit_brief stays available. Every tool call is reported to
// onStep as it starts and as it finishes, for the live trace.

const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('../lib/retry');
const { sanitizeCopy, sanitizeCopyDeep } = require('../lib/sanitizeText');
const tools = require('../qloo/tools');

// Matches the model used elsewhere in the app (src/analyzer.js).
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 16000;
const MAX_TURNS = 15;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

// With less than this left, the next turn is the last: submit_brief only.
const WRAP_UP_MS = 45 * 1000;

let client;
function getClient() {
  if (!client) {
    // maxRetries: 0 because withRetry() owns the backoff, as in outbound/ai.js.
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  }
  return client;
}

const SYSTEM_PROMPT = `You are Nivaria's Taste Gap analyst. A consumer brand wants to know where a rival's audience is that theirs is not, and which of those audiences to win first. You answer with Qloo taste data only.

Questions to answer:
1. Where is the rival's audience that ours is not? Taste segments in music, film, TV, places and other brands where the rival's audience over-indexes and ours does not.
2. Where on the map? When a city is given, the neighborhoods where the rival's audience outweighs ours, and where we already lead.
3. Which segments should we win first? A ranked list with campaign hooks built from the actual tastes.

How to work:
- First resolve every brand with search_brands, and the city with find_city when one is given. Pick the candidate that matches what the user meant; for a city, pick the city itself, not a state or county with the same name.
- Call independent tools in the same turn so they run in parallel. For each rival, run audience_gap for artist, movie, tv_show and brand, plus place when there is a city, and run demographic_gap and brand_positioning. With a city, also run geo_gap.
- Follow up only where it sharpens the answer, for example audience_gap scoped to the city for a domain where the rival leads strongly. The whole run has about three minutes, so batch your calls.
- Then call submit_brief exactly once.

Reading the data:
- Affinity runs 0 to 1 and measures how strongly an audience over-indexes on an entity or map cell. gap is rival affinity minus ours. A gap of 0.05 or more is meaningful and 0.10 or more is strong. In prose, write affinity as a score out of 100 (0.982 becomes 98).
- A segment is a cluster of related entities with large gaps (several reality fashion shows, a run of R&B artists), not a single title. Name it in plain words.
- Demographic scores run from -1 to 1, where positive means over-indexed.
- brand_positioning compares how Qloo tags the two brands. Use it for a line or two on positioning, never as audience evidence.

Rules:
- Every claim must rest on numbers from a tool result. Never invent statistics, audience sizes, revenue or trends. In evidence fields, cite entities by entity_id and map cells by geohash; the server attaches the scores. Only quote a number in prose if a tool returned it.
- Describe audiences by their tastes, places, and age and gender scores. Never infer or name race, ethnicity, religion, nationality or other protected traits, even when venues or neighborhoods seem to suggest one.
- Campaign hooks must come from the actual entities (a show, an artist, a venue, a neighborhood). Channels must be concrete, such as a creator partnership with a named show's audience or a pop-up in a named neighborhood.
- Never use em-dashes, en-dashes, or "+" as a connector between words or phrases. Write "and" instead, and use commas, periods, colons or parentheses.
- Keep text tight: a headline under 110 characters, a summary of two or three sentences, and one or two sentences per insight.`;

const SUBMIT_TOOL = {
  name: 'submit_brief',
  description: 'Submit the finished Taste Gap brief. Call it once, when the research is done. Cite entities by entity_id and map cells by geohash; the server attaches the Qloo scores, so do not restate them in evidence.',
  input_schema: {
    type: 'object',
    properties: {
      brand_id: { type: 'string', description: "Our brand's entity_id." },
      rival_ids: { type: 'array', items: { type: 'string' }, description: "The rivals' entity_ids." },
      headline: { type: 'string', description: 'One line, under 110 characters.' },
      summary: { type: 'string', description: 'Two or three sentences.' },
      rival_owned_segments: {
        type: 'array',
        description: 'Taste segments the rival owns, strongest first. Three to six.',
        items: {
          type: 'object',
          properties: {
            rival_id: { type: 'string' },
            domain: { type: 'string', enum: Object.keys(tools.DOMAINS) },
            segment: { type: 'string', description: 'A short plain name for the cluster.' },
            insight: { type: 'string', description: 'One or two sentences on what the gap means.' },
            evidence: { type: 'array', items: { type: 'string' }, description: 'entity_ids from audience_gap results.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['rival_id', 'domain', 'segment', 'insight', 'evidence', 'confidence'],
        },
      },
      win_first: {
        type: 'array',
        description: 'Ranked list of what to win first. Three to five.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer' },
            segment: { type: 'string' },
            why: { type: 'string' },
            campaign_hook: { type: 'string' },
            channels: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' }, description: 'entity_ids and geohashes behind this pick.' },
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
            rival_id: { type: 'string' },
            geohash: { type: 'string' },
            label: { type: 'string', description: 'Neighborhood or area name.' },
            note: { type: 'string', description: 'One sentence.' },
          },
          required: ['rival_id', 'geohash', 'label', 'note'],
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

const ALL_TOOLS = [...tools.TOOL_DEFS, SUBMIT_TOOL];

function userPrompt(brand, rivals, city) {
  return [
    'Our brand: ' + brand,
    'Rival' + (rivals.length > 1 ? 's' : '') + ': ' + rivals.join(', '),
    'City: ' + (city || 'none given, so skip place and geo_gap'),
  ].join('\n');
}

// ── Brief assembly ────────────────────────────────────────────────────────────

// Resolve a cited entity_id against everything audience_gap scored this run.
function findGapItem(ctx, rivalId, entityId) {
  if (rivalId && ctx.gapIndex.has(rivalId + ':' + entityId)) return { rival_id: rivalId, ...ctx.gapIndex.get(rivalId + ':' + entityId) };
  for (const [key, item] of ctx.gapIndex) {
    if (key.endsWith(':' + entityId)) return { rival_id: key.slice(0, key.indexOf(':')), ...item };
  }
  return null;
}

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

// Turn submit_brief input into the stored brief: sanitize the prose, then swap
// every citation for the Qloo numbers behind it. Anything that does not
// resolve is dropped and noted in warnings.
function assembleBrief(raw, ctx, warnings) {
  const b = sanitizeCopyDeep(raw);
  const brandId = b.brand_id;
  const rivalIds = (b.rival_ids || []).filter(id => ctx.entities.has(id));
  const brandRef = id => ({ entity_id: id, name: tools.entityName(ctx, id), image: ctx.entities.get(id)?.image || null });

  const evidenceFor = (ids, rivalId, where) => {
    const out = [];
    for (const ref of ids || []) {
      const item = findGapItem(ctx, rivalId, ref);
      if (item) { out.push({ kind: 'entity', ...item }); continue; }
      const cell = findCell(ctx, rivalId, ref);
      if (cell) { out.push({ kind: 'cell', ...cell }); continue; }
      warnings.push('Dropped unresolved citation ' + ref + ' in ' + where);
    }
    return out;
  };

  const segments = [];
  for (const s of b.rival_owned_segments || []) {
    const evidence = evidenceFor(s.evidence, s.rival_id, 'segment "' + s.segment + '"');
    if (!evidence.length) { warnings.push('Dropped segment "' + s.segment + '" with no resolvable evidence'); continue; }
    segments.push({ ...s, evidence });
  }

  const winFirst = (b.win_first || [])
    .map(w => ({ ...w, evidence: evidenceFor(w.evidence, null, 'win_first "' + w.segment + '"') }))
    .sort((x, y) => (x.rank || 0) - (y.rank || 0));

  const hotspots = [];
  for (const h of b.geo_hotspots || []) {
    const cell = findCell(ctx, h.rival_id, h.geohash);
    if (!cell) { warnings.push('Dropped hotspot ' + h.geohash); continue; }
    hotspots.push({ ...cell, label: h.label, note: h.note });
  }

  const perRival = (arr, source) => (arr || [])
    .filter(x => source[x.rival_id])
    .map(x => ({ rival_id: x.rival_id, summary: x.summary, ...source[x.rival_id] }));

  return {
    brand: ctx.entities.has(brandId) ? brandRef(brandId) : null,
    rivals: rivalIds.map(brandRef),
    headline: b.headline || '',
    summary: b.summary || '',
    rival_owned_segments: segments,
    win_first: winFirst,
    geo_hotspots: hotspots,
    demographic_gap: perRival(b.demographic_gap, ctx.demographics),
    positioning: perRival(b.positioning, ctx.positioning),
  };
}

// Everything the UI charts, straight from Qloo: gaps per domain, the full
// heatmap join for the map, demographics and positioning, keyed by rival.
function chartData(ctx) {
  const geo = {};
  for (const [rid, g] of Object.entries(ctx.geo)) {
    geo[rid] = { locality: g.locality, stats: g.stats, cells: g.cells };
  }
  return { gaps: ctx.gaps, geo, demographics: ctx.demographics, positioning: ctx.positioning };
}

function checkBrief(input, ctx) {
  const problems = [];
  if (!input || typeof input !== 'object') return ['submit_brief input must be an object.'];
  if (!ctx.entities.has(input.brand_id)) problems.push('brand_id must be an entity_id from search_brands.');
  const rivals = Array.isArray(input.rival_ids) ? input.rival_ids : [];
  if (!rivals.length || rivals.some(id => !ctx.entities.has(id))) problems.push('rival_ids must be entity_ids from search_brands.');
  for (const k of ['headline', 'summary']) if (!input[k] || typeof input[k] !== 'string') problems.push(k + ' is required.');
  if (!Array.isArray(input.rival_owned_segments) || !input.rival_owned_segments.length) problems.push('rival_owned_segments needs at least one segment.');
  if (!Array.isArray(input.win_first) || !input.win_first.length) problems.push('win_first needs at least one item.');
  return problems;
}

// ── Loop ──────────────────────────────────────────────────────────────────────

// Keep one moving cache breakpoint on the newest message, so each turn reads
// the previous turn's prefix from cache. The system prompt carries the other.
function moveCacheBreakpoint(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const block of m.content) delete block.cache_control;
  }
  const last = messages[messages.length - 1];
  if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
  last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
}

function addUsage(total, u) {
  if (!u) return;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    total[k] += u[k] || 0;
  }
}

async function runTasteAgent({ brand, rivals, city, onStep, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const brandName = String(brand || '').trim();
  const rivalNames = (Array.isArray(rivals) ? rivals : [rivals]).map(r => String(r || '').trim()).filter(Boolean);
  if (!brandName) throw new Error('brand is required');
  if (rivalNames.length < 1 || rivalNames.length > 2) throw new Error('give one or two rivals');
  const cityName = city ? String(city).trim() : '';

  const ctx = tools.createContext();
  const steps = [];
  const warnings = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
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

  const messages = [{ role: 'user', content: userPrompt(brandName, rivalNames, cityName) }];
  let submitted = null;
  let turns = 0;
  let wrapUp = false;

  try {
    while (!submitted) {
      if (turns >= MAX_TURNS) throw new Error('The agent used all ' + MAX_TURNS + ' turns without submitting a brief');
      turns += 1;
      if (!wrapUp && (turns === MAX_TURNS || deadline - Date.now() < WRAP_UP_MS)) {
        wrapUp = true;
        const last = messages[messages.length - 1];
        if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
        last.content.push({ type: 'text', text: 'Time is almost up. Call submit_brief now with what you have.' });
      }
      moveCacheBreakpoint(messages);

      const remaining = Math.max(5000, deadline - Date.now());
      const response = await withRetry(() => getClient().messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: wrapUp ? [SUBMIT_TOOL] : ALL_TOOLS,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        messages,
      }, { signal: controller.signal, timeout: remaining }), { label: 'taste agent' });
      addUsage(usage, response.usage);
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') throw new Error('The model declined this request');

      // Narration between tool calls goes to the trace as a note.
      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) {
          const note = openStep({ kind: 'note', label: sanitizeCopy(block.text.trim()) });
          closeStep(note, { status: 'done' });
        }
      }

      const uses = response.content.filter(b => b.type === 'tool_use');
      if (!uses.length) {
        messages.push({ role: 'user', content: response.stop_reason === 'max_tokens'
          ? 'Your reply was cut off. Call submit_brief with a shorter brief.'
          : 'Call submit_brief with the finished brief rather than replying in text.' });
        continue;
      }

      const results = await Promise.all(uses.map(async use => {
        if (use.name === 'submit_brief') {
          const step = openStep({ kind: 'tool', tool: 'submit_brief', label: 'Writing the brief', turn: turns });
          const problems = checkBrief(use.input, ctx);
          if (problems.length) {
            closeStep(step, { status: 'error', summary: problems.join(' ') });
            return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: problems.join(' ') };
          }
          submitted = use.input;
          closeStep(step, { status: 'done', summary: 'Brief submitted' });
          return { type: 'tool_result', tool_use_id: use.id, content: 'Brief received.' };
        }
        const step = openStep({
          kind: 'tool', tool: use.name, input: use.input, turn: turns,
          label: tools.describeCall(ctx, use.name, use.input),
        });
        const out = await tools.executeTool(ctx, use.name, use.input);
        closeStep(step, { status: out.ok ? 'done' : 'error', summary: out.ok ? out.summary : out.error });
        return out.ok
          ? { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out.result) }
          : { type: 'tool_result', tool_use_id: use.id, is_error: true, content: out.error };
      }));
      // All results for one turn go back in a single user message.
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    const e = new Error(timedOut ? 'The agent ran out of time before writing the brief' : err.message);
    e.steps = steps;
    e.usage = usage;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const brief = assembleBrief(submitted, ctx, warnings);
  return {
    brief,
    data: chartData(ctx),
    steps,
    warnings,
    usage,
    model: MODEL,
    turns,
    duration_ms: Date.now() - started,
    input: { brand: brandName, rivals: rivalNames, city: cityName || null },
  };
}

module.exports = { runTasteAgent, MODEL };
