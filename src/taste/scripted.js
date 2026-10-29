// Taste Gap: the scripted model stand-in.
//
// A provider that plays the model's part from a fixed script, so the routes,
// the live trace and the UI can be built and demoed without spending model
// quota. It never calls an LLM. The rest of the run is real: the agent loop,
// the Qloo tools, citation resolution and sanitizing all work exactly as they
// do for a real model. Opt in with LLM_CHAIN=scripted.
//
// The script reads the provider-neutral transcript (see src/taste/llm.js) and
// answers in three turns:
//   1. search_brands for our brand and each rival, and find_city for the city.
//   2. Every comparison in parallel, as the system prompt asks: audience_gap
//      per domain (place too when there is a city), demographic_gap,
//      brand_positioning, and geo_gap with a city.
//   3. submit_brief, written from the rows those tools returned and citing
//      them by ref. The prose is templated, so it reads plainer than a model's.
//
// Names come from the opening prompt the agent writes (userPrompt in
// agent.js). Rivals are joined there with ", ", so a rival whose name holds a
// comma splits in two; the stand-in is a dev tool and lives with that.

const { DOMAINS } = require('../qloo/tools');

const DELAY_MS = 400;
const MEANINGFUL_GAP = 5;   // points; matches the system prompt's reading
const STRONG_GAP = 10;
const SEGMENTS_MAX = 4;
const WIN_FIRST_MAX = 3;

function scriptError(message) {
  // No status, so classifyFailure() treats it as fatal for the run.
  return new Error('Scripted stand-in: ' + message);
}

function parseOpening(transcript) {
  const text = transcript.find(t => t.role === 'user')?.text || '';
  const line = re => (re.exec(text) || [])[1]?.trim() || '';
  const city = line(/^City: (.*)$/m);
  return {
    brand: line(/^Our brand: (.*)$/m),
    rivals: line(/^Rivals?: (.*)$/m).split(', ').filter(Boolean),
    city: /^none given/.test(city) ? '' : city,
  };
}

// Every tool call so far with its parsed result: [{ name, input, result, isError }].
function collectCalls(transcript) {
  const byId = new Map();
  for (const t of transcript) {
    if (t.role === 'assistant') for (const c of t.calls || []) byId.set(c.id, { name: c.name, input: c.input || {} });
    if (t.role === 'tool') {
      for (const r of t.results) {
        const call = byId.get(r.id);
        if (!call) continue;
        let result = null;
        if (!r.isError) { try { result = JSON.parse(r.content); } catch (_) {} }
        call.result = result;
        call.isError = Boolean(r.isError);
      }
    }
  }
  return [...byId.values()].filter(c => 'result' in c);
}

let callSeq = 0;
const call = (name, input) => ({ id: 'scripted_' + (++callSeq), name, input, inputError: null, extra: null });

function lookups(opening) {
  const calls = [opening.brand, ...opening.rivals].map(query => call('search_brands', { query }));
  if (opening.city) calls.push(call('find_city', { query: opening.city }));
  return calls;
}

// The first candidate for each name, as the script's "pick".
function resolvePicks(opening, done) {
  const pick = query => {
    const hit = done.find(c => c.name === 'search_brands' && c.input.query === query);
    const top = hit?.result?.results?.[0];
    if (!top) throw scriptError('Qloo found no brand matching "' + query + '"');
    return { ref: top.ref, name: top.name };
  };
  const brand = pick(opening.brand);
  const rivals = opening.rivals.map(pick).filter(r => r.ref !== brand.ref);
  if (!rivals.length) throw scriptError('the rival resolved to the same Qloo brand as ours');
  const cityHit = done.find(c => c.name === 'find_city');
  const top = cityHit?.result?.results?.[0];
  return { brand, rivals, city: top ? { ref: top.ref, name: top.name } : null };
}

function comparisons(picks) {
  const calls = [];
  for (const rival of picks.rivals) {
    const pair = { brand_id: picks.brand.ref, rival_id: rival.ref };
    for (const domain of Object.keys(DOMAINS)) {
      if (domain === 'place' && !picks.city) continue;
      calls.push(call('audience_gap', { ...pair, domain, ...(domain === 'place' ? { locality_id: picks.city.ref } : {}) }));
    }
    calls.push(call('demographic_gap', pair));
    calls.push(call('brand_positioning', pair));
    if (picks.city) calls.push(call('geo_gap', { ...pair, locality_id: picks.city.ref }));
  }
  return calls;
}

function mostCommonTag(rows) {
  const counts = {};
  for (const r of rows) {
    for (const tag of String(r[5] || '').split(', ').filter(Boolean)) counts[tag] = (counts[tag] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

const listNames = names => (names.length < 3 ? names.join(' and ') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]);
const ageWords = key => key.replace(/_/g, ' ').replace('24 and younger', '24 and under');

function writeBrief(picks, done) {
  const of = (name, rivalRef) => done.filter(c => c.name === name && c.input.rival_id === rivalRef && c.result);
  const brand = picks.brand.name;

  // Candidate segments: one per rival and domain, ranked by mean gap.
  const candidates = [];
  for (const rival of picks.rivals) {
    for (const c of of('audience_gap', rival.ref)) {
      const rows = (c.result.rows || []).filter(r => r[4] != null && r[4] >= MEANINGFUL_GAP);
      if (!rows.length) continue;
      const label = DOMAINS[c.result.domain]?.label || c.result.domain;
      const tag = mostCommonTag(rows.slice(0, 6));
      candidates.push({ rival, domain: c.result.domain, label, tag, rows, mean: c.result.mean_gap || 0, strong: c.result.strong_gaps || 0 });
    }
  }
  candidates.sort((a, b) => b.mean - a.mean);
  const chosen = candidates.slice(0, SEGMENTS_MAX);
  if (!chosen.length) throw scriptError('no audience gap of ' + MEANINGFUL_GAP + ' points or more came back, so there is nothing to brief');

  const hotspotsFor = rival => (of('geo_gap', rival.ref)[0]?.result?.rival_hotspots || []).filter(r => r[1] || r[2]);
  const placeName = r => r[1] || r[2];

  const segments = chosen.map(s => {
    const top = s.rows.slice(0, 3);
    return {
      rival_id: s.rival.ref,
      domain: s.domain,
      segment: s.tag ? s.tag + ' (' + s.label + ')' : s.rival.name + ' ' + s.label + ' picks',
      insight: s.rival.name + ' fans over-index on ' + listNames(top.map(r => r[1])) + ', a mean gap of '
        + s.mean + ' points over ' + brand + ' in ' + s.label + '.',
      evidence: top.map(r => r[0]),
      confidence: s.strong >= 3 ? 'high' : s.strong >= 1 ? 'medium' : 'low',
    };
  });

  const winFirst = chosen.slice(0, WIN_FIRST_MAX).map((s, i) => {
    const lead = s.rows[0];
    const spot = hotspotsFor(s.rival)[0];
    const channels = ['Creator partnership with the ' + lead[1] + ' audience'];
    if (spot) channels.push('Pop-up in ' + placeName(spot));
    return {
      rank: i + 1,
      segment: segments[i].segment,
      why: 'Widest ' + s.label + ' gap: ' + lead[1] + ' scores ' + lead[2] + ' for ' + s.rival.name + ' fans and ' + lead[3] + ' for ' + brand + '.',
      campaign_hook: 'Put ' + brand + ' where ' + lead[1] + ' fans already are, with a ' + s.label + ' tie-in built around ' + lead[1] + '.',
      channels,
      evidence: [lead[0], ...(spot ? [spot[0]] : [])],
    };
  });

  const geo = [];
  for (const rival of picks.rivals) {
    for (const r of hotspotsFor(rival).slice(0, 3)) {
      geo.push({ ref: r[0], label: placeName(r), note: rival.name + ' scores ' + r[4] + ' here and ' + brand + ' scores ' + r[5] + '.' });
    }
  }

  const demographics = [];
  for (const rival of picks.rivals) {
    const d = of('demographic_gap', rival.ref)[0]?.result;
    if (!d?.age) continue;
    const widest = [...d.age].sort((a, b) => Math.abs(b[3] || 0) - Math.abs(a[3] || 0))[0];
    const side = (widest[3] || 0) >= 0 ? rival.name : brand;
    demographics.push({
      rival_id: rival.ref,
      summary: 'The widest age gap is ' + ageWords(widest[0]) + ', where ' + side + ' leads (' + rival.name + ' ' + widest[2] + ', ' + brand + ' ' + widest[1] + ').',
    });
  }

  const positioning = [];
  for (const rival of picks.rivals) {
    const p = of('brand_positioning', rival.ref)[0]?.result;
    if (!p) continue;
    const shared = (p.shared || []).slice(0, 3).map(s => s.replace(/\s*\(\d+\)$/, ''));
    const theirs = (p.rival_only || []).slice(0, 3);
    const parts = [];
    if (shared.length) parts.push('Both brands are tagged ' + listNames(shared) + '.');
    if (theirs.length) parts.push('Only ' + rival.name + ' carries ' + listNames(theirs) + '.');
    if (parts.length) positioning.push({ rival_id: rival.ref, summary: parts.join(' ') });
  }

  const lead = chosen[0];
  const rivalNames = listNames(picks.rivals.map(r => r.name));
  const headline = (lead.rival.name + ' leads ' + brand + ' in ' + lead.label + (chosen[1] && chosen[1].label !== lead.label ? ' and ' + chosen[1].label : '')).slice(0, 108);
  return {
    brand_id: picks.brand.ref,
    rival_ids: picks.rivals.map(r => r.ref),
    headline,
    summary: 'Qloo audience data shows where ' + rivalNames + ' reach' + (picks.rivals.length > 1 ? '' : 'es') + ' fans that '
      + brand + ' does not. The widest gap is ' + lead.label + ', led by ' + lead.rows[0][1] + '.',
    rival_owned_segments: segments,
    win_first: winFirst,
    geo_hotspots: geo,
    demographic_gap: demographics,
    positioning,
  };
}

function scriptedProvider(entry, cfg) {
  return {
    ...entry, label: cfg.label, timeoutMs: cfg.timeoutMs, inputBudget: 0,
    async complete({ transcript, finalOnly }) {
      await new Promise(r => setTimeout(r, Number(process.env.SCRIPTED_DELAY_MS ?? DELAY_MS)));
      const opening = parseOpening(transcript);
      if (!opening.brand || !opening.rivals.length) throw scriptError('could not read the brand and rivals from the opening prompt');
      const done = collectCalls(transcript);

      let calls;
      let text = '';
      if (!done.some(c => c.name === 'search_brands')) {
        if (finalOnly) throw scriptError('ran out of time before the lookups');
        calls = lookups(opening);
        text = 'Resolving the brands' + (opening.city ? ' and the city' : '') + ' first.';
      } else {
        const picks = resolvePicks(opening, done);
        if (!done.some(c => c.name === 'audience_gap')) {
          if (finalOnly) throw scriptError('ran out of time before the comparisons');
          calls = comparisons(picks);
          text = 'Running every comparison for ' + listNames(picks.rivals.map(r => r.name)) + ' in parallel.';
        } else {
          calls = [call('submit_brief', writeBrief(picks, done))];
        }
      }
      return {
        text,
        calls,
        stopReason: 'tool_use',
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        native: null,
      };
    },
  };
}

module.exports = { scriptedProvider, parseOpening, writeBrief };
