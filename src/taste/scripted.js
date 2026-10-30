// Taste Gap: the scripted model stand-in.
//
// A provider that plays the model's part from a fixed script, so the routes,
// the live trace and the UI can be built and demoed without spending model
// quota. It never calls an LLM. The rest of the run is real: the agent loop,
// the Qloo tools, citation resolution and sanitizing all work exactly as they
// do for a real model. Opt in with LLM_CHAIN=scripted.
//
// The script reads the provider-neutral transcript (see src/taste/llm.js) and
// answers in four turns, as the system prompt asks:
//   1. plan, with four steps, alongside search_brands for our brand and each
//      rival and find_city for the city.
//   2. audience_gap per domain (place too when there is a city) and
//      brand_positioning, in parallel. When the city could not be found, the
//      plan is revised here, with the reason.
//   3. follow_lead on the strongest gap, with demographic_gap and, with a
//      city, geo_gap, in parallel.
//   4. submit_brief, written from the rows those tools returned and citing
//      them by ref, with the rank 1 pick built on what follow_lead found. The
//      prose is templated, so it reads plainer than a model's.
// With no rival named it first discovers one: discover_rivals for our brand,
// then choose_rivals with the first unflagged candidate (they arrive ranked
// by shared category tags, then affinity), before step 2.
//
// SCRIPTED_QUOTA_AFTER=n makes it run out of quota for tests: every call
// after the nth brief it writes from then on fails with a 429 whose wait is
// too long to sit out, as a spent Gemini daily quota does.
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
    rivals: /^none given/.test(line(/^Rivals?: (.*)$/m)) ? [] : line(/^Rivals?: (.*)$/m).split(', ').filter(Boolean),
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

// The plan the script states in its first turn, or again (with a reason)
// when the city turns out not to exist.
function planSteps(opening, city) {
  const named = opening.rivals.length > 0;
  const steps = [{
    step: 'Look up ' + listNames([opening.brand, ...opening.rivals]) + ' in Qloo' + (city ? ', and find ' + city : ''),
    tools: ['search_brands', ...(city ? ['find_city'] : [])],
  }];
  if (!named) steps.push({ step: 'Find the brands whose audiences overlap with ' + opening.brand + ' and choose the closest rival', tools: ['discover_rivals', 'choose_rivals'] });
  const compare = 'Compare the audiences in music, film, TV and other brands' + (city ? ', and places in ' + city : '');
  const follow = 'follow the strongest lead and compare the age and gender mix' + (city ? ', and map both audiences across ' + city : '');
  if (named) {
    steps.push({ step: compare + ', and how Qloo tags each brand', tools: ['audience_gap', 'brand_positioning'] });
    steps.push({ step: follow.charAt(0).toUpperCase() + follow.slice(1), tools: ['follow_lead', 'demographic_gap', ...(city ? ['geo_gap'] : [])] });
  } else {
    steps.push({
      step: 'Compare the audiences, follow the strongest lead' + (city ? ' and map ' + city : ' and compare the age and gender mix'),
      tools: ['audience_gap', 'brand_positioning', 'follow_lead', 'demographic_gap', ...(city ? ['geo_gap'] : [])],
    });
  }
  steps.push({ step: 'Write the brief, with the top pick built on the lead', tools: ['submit_brief'] });
  return steps;
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
  const chosen = done.find(c => c.name === 'choose_rivals' && c.result)?.result?.chosen;
  const rivals = (opening.rivals.length ? opening.rivals.map(pick) : chosen || []).filter(r => r.ref !== brand.ref);
  if (!rivals.length) throw scriptError('the rival resolved to the same Qloo brand as ours');
  const city = done.find(c => c.name === 'find_city')?.result?.city;
  return { brand, rivals, city: city ? { ref: city.ref, name: city.name } : null };
}

// The discovered candidate a model is told to prefer: the first unflagged
// one, since discover_rivals ranks them by shared category tags, then
// affinity. Rows are [ref, name, affinity, popularity, shared_tags, category,
// found_by, flags].
function chooseFrom(brand, discovered) {
  const rows = (discovered?.rows || []).map(r => ({ ref: r[0], name: r[1], affinity: r[2], shared: r[4] ? r[4].split(', ') : [], flags: r[7] }));
  const best = rows.find(r => !r.flags) || rows[0];
  if (!best) throw scriptError('Qloo returned no brands to choose a rival from');
  const tags = best.shared.slice(0, 2);
  return call('choose_rivals', {
    rival_ids: [best.ref],
    reason: best.name + ' is the closest competitor: its audience affinity with ' + brand.name + "'s fans is " + best.affinity
      + (tags.length ? ' and it shares the category tags ' + listNames(tags) + '.' : ', the highest among the candidates.'),
  });
}

// Turn 2: the audience gaps and positioning.
function comparisons(picks) {
  const calls = [];
  for (const rival of picks.rivals) {
    const pair = { brand_id: picks.brand.ref, rival_id: rival.ref };
    for (const domain of Object.keys(DOMAINS)) {
      if (domain === 'place' && !picks.city) continue;
      calls.push(call('audience_gap', { ...pair, domain, ...(domain === 'place' ? { locality_id: picks.city.ref } : {}) }));
    }
    calls.push(call('brand_positioning', pair));
  }
  return calls;
}

// The lead to follow: the audience_gap row with the widest gap across every
// rival and domain. Venue gaps run wider (they are scoped to the city) and
// are often bars, which a hook may not use, so music, film, TV and brands
// come first and a venue is followed only when nothing else has a gap.
// Rows are [ref, name, rival, ours, gap, tags].
function strongestGap(done) {
  const best = { place: null, other: null };
  for (const c of done.filter(x => x.name === 'audience_gap' && x.result)) {
    const k = c.result.domain === 'place' ? 'place' : 'other';
    for (const r of c.result.rows || []) if (r[4] != null && (!best[k] || r[4] > best[k][4])) best[k] = r;
  }
  return best.other || best.place;
}

// Turn 3: follow the strongest lead, with the map and demographics.
function leadAndMap(picks, done) {
  const calls = [];
  const lead = strongestGap(done);
  if (lead) calls.push(call('follow_lead', { entity_ref: lead[0], ...(picks.city ? { locality_id: picks.city.ref } : {}) }));
  for (const rival of picks.rivals) {
    const pair = { brand_id: picks.brand.ref, rival_id: rival.ref };
    calls.push(call('demographic_gap', pair));
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

  // geo_gap rows are [ref, place, top_places, rival, ours, gap].
  const hotspotsFor = rival => (of('geo_gap', rival.ref)[0]?.result?.rival_hotspots || []).filter(r => r[1]);
  const placeName = r => r[1];

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

  // Rank 1 is built on follow_lead: the followed entity's gap, and what its
  // fans also over-index on. Lead rows are [ref, name, affinity, tags] under
  // music, places, brands and TV.
  const winFirst = [];
  const followed = done.find(c => c.name === 'follow_lead' && c.result);
  if (followed) {
    const gapCall = done.find(c => c.name === 'audience_gap' && c.result && (c.result.rows || []).some(r => r[0] === followed.input.entity_ref));
    const seed = gapCall?.result.rows.find(r => r[0] === followed.input.entity_ref);
    const rival = picks.rivals.find(r => r.ref === gapCall?.input.rival_id) || picks.rivals[0];
    const tops = ['music', 'brands', 'TV', 'places'].map(k => (followed.result[k] || [])[0]).filter(Boolean).slice(0, 3);
    if (seed && tops.length) {
      const music = (followed.result.music || [])[0];
      winFirst.push({
        rank: 1,
        segment: 'Fans of ' + seed[1],
        why: seed[1] + ' scores ' + seed[2] + ' for ' + rival.name + ' fans and ' + seed[3] + ' for ' + brand
          + ', the widest ' + (DOMAINS[gapCall.result.domain]?.label || '') + ' gap, and its fans also over-index on ' + listNames(tops.map(t => t[1])) + '.',
        campaign_hook: 'Meet ' + seed[1] + ' fans where their tastes already go: ' + listNames(tops.map(t => t[1])) + '.',
        channels: ['Creator partnership with the ' + seed[1] + ' audience', ...(music && music[1] !== seed[1] ? ['Tie-in with ' + music[1]] : [])],
        evidence: [seed[0], ...tops.map(t => t[0])],
      });
    }
  }
  winFirst.push(...chosen.slice(0, WIN_FIRST_MAX - winFirst.length).map((s, i) => {
    const lead = s.rows[0];
    const spot = hotspotsFor(s.rival)[0];
    const channels = ['Creator partnership with the ' + lead[1] + ' audience'];
    if (spot) channels.push('Pop-up in ' + placeName(spot));
    return {
      rank: winFirst.length + i + 1,
      segment: segments[i].segment,
      why: 'Widest ' + s.label + ' gap: ' + lead[1] + ' scores ' + lead[2] + ' for ' + s.rival.name + ' fans and ' + lead[3] + ' for ' + brand + '.',
      campaign_hook: 'Put ' + brand + ' where ' + lead[1] + ' fans already are, with a ' + s.label + ' tie-in built around ' + lead[1] + '.',
      channels,
      evidence: [lead[0], ...(spot ? [spot[0]] : [])],
    };
  }));

  const geo = [];
  for (const rival of picks.rivals) {
    for (const r of hotspotsFor(rival).slice(0, 3)) {
      geo.push({ ref: r[0], label: placeName(r), note: rival.name + ' scores ' + r[3] + ' here and ' + brand + ' scores ' + r[4] + '.' });
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

let briefsWritten = 0;
let quota = { raw: '', from: 0 };

// Counted from when SCRIPTED_QUOTA_AFTER last changed, so a test can allow
// "three more briefs" whatever ran before.
function quotaSpent() {
  const raw = process.env.SCRIPTED_QUOTA_AFTER || '';
  if (raw !== quota.raw) quota = { raw, from: briefsWritten };
  return raw !== '' && briefsWritten - quota.from >= Number(raw);
}

function scriptedProvider(entry, cfg) {
  return {
    ...entry, label: cfg.label, timeoutMs: cfg.timeoutMs, inputBudget: 0,
    async complete({ transcript, finalOnly }) {
      await new Promise(r => setTimeout(r, Number(process.env.SCRIPTED_DELAY_MS ?? DELAY_MS)));
      if (quotaSpent()) {
        throw Object.assign(new Error('Scripted stand-in: quota exhausted (429)'), { status: 429, retryAfterMs: 60 * 60 * 1000 });
      }
      const opening = parseOpening(transcript);
      if (!opening.brand) throw scriptError('could not read the brand from the opening prompt');
      const done = collectCalls(transcript);

      let calls;
      let text = '';
      if (!done.some(c => c.name === 'search_brands')) {
        if (finalOnly) throw scriptError('ran out of time before the lookups');
        calls = [call('plan', { steps: planSteps(opening, opening.city) }), ...lookups(opening)];
        text = 'Resolving the brands' + (opening.city ? ' and the city' : '') + ' first.';
      } else if (!opening.rivals.length && !done.some(c => c.name === 'discover_rivals')) {
        if (finalOnly) throw scriptError('ran out of time before finding rivals');
        const brand = done.find(c => c.name === 'search_brands')?.result?.results?.[0];
        if (!brand) throw scriptError('Qloo found no brand matching "' + opening.brand + '"');
        calls = [call('discover_rivals', { brand_id: brand.ref })];
        text = 'No rival was named, so finding the brands whose audiences overlap most with ' + brand.name + '.';
      } else if (!opening.rivals.length && !done.some(c => c.name === 'choose_rivals' && c.result)) {
        if (finalOnly) throw scriptError('ran out of time before choosing rivals');
        const brand = done.find(c => c.name === 'search_brands').result.results[0];
        calls = [chooseFrom(brand, done.find(c => c.name === 'discover_rivals')?.result)];
        text = 'Choosing the rival from the candidates in the same category.';
      } else {
        const picks = resolvePicks(opening, done);
        if (!done.some(c => c.name === 'audience_gap')) {
          if (finalOnly) throw scriptError('ran out of time before the comparisons');
          calls = comparisons(picks);
          text = 'Comparing the audiences for ' + listNames(picks.rivals.map(r => r.name)) + ' in parallel.';
          // The city named in the request does not exist in Qloo: say so in a
          // revised plan, and carry on without places and the map.
          if (opening.city && !picks.city) {
            calls.unshift(call('plan', {
              steps: planSteps(opening, ''),
              reason: 'Qloo found no city called ' + opening.city + ', so the brief skips places and the map.',
            }));
          }
        } else if (!done.some(c => c.name === 'demographic_gap')) {
          if (finalOnly) throw scriptError('ran out of time before following the lead');
          calls = leadAndMap(picks, done);
          text = 'Following the strongest lead' + (picks.city ? ' while mapping ' + picks.city.name : '') + '.';
        } else {
          calls = [call('submit_brief', writeBrief(picks, done))];
          briefsWritten += 1;
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
