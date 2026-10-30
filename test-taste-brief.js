// Taste Gap brief assembly: the post-processing between submit_brief and the
// stored brief.
//
//   node test-taste-brief.js
//
// Fills a run context through the real tools on the fake Qloo
// (scripts/qloo-fake.js), so it needs no keys and makes no network calls,
// then feeds assembleBrief() model output with the faults seen on the live
// site: rule text echoed into channel tags, raw data keys in prose, Title Case
// tags, and a brief that names no hotspots for a mapped city.

require('./scripts/qloo-fake');
const tools = require('./src/qloo/tools');
const { assembleBrief, nameRefs } = require('./src/taste/agent');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  ok   ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

async function context() {
  const ctx = tools.createContext();
  const run = async (name, input) => {
    const out = await tools.executeTool(ctx, name, input);
    if (!out.ok) throw new Error(name + ': ' + out.error);
    return out.result;
  };
  const brand = (await run('search_brands', { query: 'Starbucks' })).results[0].ref;
  const rival = (await run('search_brands', { query: "Dunkin'" })).results[0].ref;
  const city = (await run('find_city', { query: 'New York' })).city.ref;
  const artists = await run('audience_gap', { brand_id: brand, rival_id: rival, domain: 'artist' });
  await run('geo_gap', { brand_id: brand, rival_id: rival, locality_id: city });
  return { ctx, brand, rival, artist: artists.rows[0] };
}

function rawBrief({ brand, rival, artist }, extra = {}) {
  return {
    brand_id: brand,
    rival_ids: [rival],
    headline: 'Dunkin leads with fans aged 35_to_44',
    summary: 'Fans aged 35_to_44 and 24_and_younger lean Dunkin (avoid hangover framing). The tv_show gap is small.',
    rival_owned_segments: [{
      rival_id: rival, domain: 'artist', segment: 'Indie pop listeners', confidence: 'high',
      insight: 'A clear lead (gap 15) in indie pop.', evidence: [artist[0]],
    }],
    win_first: [{
      rank: 1,
      segment: 'Indie pop listeners',
      why: 'The widest music gap.',
      campaign_hook: 'A pop-up near the waterfront (no alcohol angle) with ' + artist[1] + ' playlists.',
      channels: [
        'Creator partnerships (no alcohol angle)',
        'No alcohol angle',
        'out of home billboards',
        'Audio Streaming Ads For ' + artist[1] + ' Listeners',
        'Spotify Playlist Takeovers',
        'TikTok creator duets',
      ],
      evidence: [artist[0]],
    }],
    geo_hotspots: [],
    ...extra,
  };
}

(async () => {
  const run = await context();
  const warnings = [];
  const b = assembleBrief(rawBrief(run), run.ctx, warnings);
  const w = b.win_first[0];

  console.log('rule echoes');
  check('a parenthetical instruction is stripped from a channel', w.channels[0] === 'Creator partnerships', JSON.stringify(w.channels));
  check('a channel that is only an instruction is dropped', !w.channels.some(c => /alcohol/i.test(c)), JSON.stringify(w.channels));
  check('a parenthetical instruction is stripped from a hook', !/alcohol|\(\s*\)/i.test(w.campaign_hook) && /waterfront with/.test(w.campaign_hook), w.campaign_hook);
  check('an instruction aside is stripped from the summary', !/hangover/i.test(b.summary), b.summary);
  check('an ordinary parenthetical is kept', /\(gap 15\)/.test(b.rival_owned_segments[0].insight), b.rival_owned_segments[0].insight);

  console.log('raw keys');
  check('age keys read as words', /aged 35 to 44 and 24 and younger/.test(b.summary) && /35 to 44/.test(b.headline), b.summary);
  check('no underscore keys left in prose', !/\w_\w/.test(b.headline + b.summary), b.summary);
  check('tv_show reads as TV', /The TV gap/.test(b.summary), b.summary);

  console.log('channel case');
  check('a lowercase tag is capitalized', w.channels.includes('Out of home billboards'), JSON.stringify(w.channels));
  check('a Title Case tag becomes sentence case, keeping a known name', w.channels.includes('Audio streaming ads for ' + run.artist[1] + ' listeners'), JSON.stringify(w.channels));
  check('platform and inner-capital names keep their case', w.channels.includes('Spotify playlist takeovers') && w.channels.includes('TikTok creator duets'), JSON.stringify(w.channels));

  console.log('hotspots');
  const spots = b.geo_hotspots;
  check('a mapped city with no hotspots in the brief gets them from geo_gap', spots.length > 0 && spots.length <= 5, String(spots.length));
  check('filled hotspots carry a rival, a position and a note', spots.every(h => h.rival_id && h.lat != null && h.lng != null && /scores \d+ here and .* scores \d+\./.test(h.note)), JSON.stringify(spots[0]));
  check('labelled cells come first', spots.findIndex(h => !h.label) === -1 || spots.slice(0, spots.findIndex(h => !h.label)).every(h => h.label));
  check('the fill is noted in warnings', warnings.some(x => /no hotspots/.test(x)), JSON.stringify(warnings));
  check('no em or en dash in the brief', !/[\u2013\u2014]/.test(JSON.stringify(b)));

  const cellRef = [...run.ctx.refs.entries()].find(([, v]) => v.kind === 'cell')[0];
  const own = assembleBrief(rawBrief(run, { geo_hotspots: [{ ref: cellRef, label: 'x', note: 'Model note.' }] }), run.ctx, []);
  check("the model's own hotspots are kept as they are", own.geo_hotspots.length === 1 && own.geo_hotspots[0].note === 'Model note.', JSON.stringify(own.geo_hotspots.map(h => h.note)));

  console.log('unsupported traits');
  check('a clean brief drops nothing for traits', !warnings.some(x => /trait/.test(x)), JSON.stringify(warnings));

  // Capture the server log the backstop writes to.
  const logged = [];
  const origWarn = console.warn;
  console.warn = (...m) => { logged.push(m.join(' ')); };
  const traitWarnings = [];
  const TRAIT_SENTENCES = [
    'They are price-sensitive commuters.',
    'Price sensitive shoppers lean in.',
    'Most stick to a budget.',
    'Budget-conscious families visit often.',
    'They shop on a tight budget.',
    'Budget shoppers lead here.',
    'It skews budget-minded.',
    'The audience is affluent.',
    'Wealthy fans drive the gap.',
    'Low-income households over-index.',
    'High income earners lead here.',
    'These are educated professionals.',
    'College-educated fans skew this way.',
    'It reads as a blue-collar crowd.',
    'White collar workers dominate.',
  ];
  const t = assembleBrief(rawBrief(run, {
    summary: 'Fans aged 35_to_44 lean Dunkin. ' + TRAIT_SENTENCES.join(' ') + ' The TV gap is small.',
  }), run.ctx, traitWarnings);
  check('every listed trait word drops its sentence and only that sentence', t.summary === 'Fans aged 35 to 44 lean Dunkin. The TV gap is small.', t.summary);
  check('each dropped sentence is a warning naming the trait', traitWarnings.filter(x => /trait no tool returned/.test(x)).length === TRAIT_SENTENCES.length
    && traitWarnings.some(x => /"price-sensitive"/.test(x)) && traitWarnings.some(x => /"blue-collar"/i.test(x)), JSON.stringify(traitWarnings));
  check('the warnings do not repeat the dropped claim', !traitWarnings.some(x => /commuters|households|professionals/.test(x)));
  check('the server log keeps the dropped sentence and where it was', logged.some(x => /summary: They are price-sensitive commuters\./.test(x)), logged[0]);

  const marketing = assembleBrief(rawBrief(run, {
    summary: 'Shift media budget toward Bushwick. Set aside budget for a creator partnership. A budget-friendly pop-up works. Budgets for TV can shrink.',
  }), run.ctx, []);
  check('marketing sentences about budget stay', marketing.summary === 'Shift media budget toward Bushwick. Set aside budget for a creator partnership. A budget-friendly pop-up works. Budgets for TV can shrink.', marketing.summary);

  // Commuting and time of day: what the featured Starbucks brief said on
  // 2026-10-30, and the tactics that must survive.
  const commuteWarnings = [];
  const commute = assembleBrief(rawBrief(run, {
    headline: 'Win Dunkin country pop listeners and Staten Island morning commuters',
    summary: 'Fans aged 35_to_44 lean Dunkin. They are commuters. Late-night crowds pick Dunkin. Weekday coffee drinkers lean in. Early risers stop by. People commute through Bushwick. The TV gap is small.',
    win_first: [
      { rank: 1, segment: 'Staten Island Suburban Commuters', why: 'A wide map gap.', campaign_hook: 'Pop-ups.', channels: [], evidence: [run.artist[0]] },
      { rank: 2, segment: 'Indie pop listeners', why: 'Morning drive-thru rewards work here.', campaign_hook: 'Indie pop playlists at the counter.',
        channels: ['Out of home billboards along Staten Island commute corridors', 'Morning drive time radio placements'], evidence: [run.artist[0]] },
    ],
  }), run.ctx, commuteWarnings);
  check('commuting and time-of-day audience descriptors drop their sentences', commute.summary === 'Fans aged 35 to 44 lean Dunkin. The TV gap is small.', commute.summary);
  check('a headline naming morning commuters is rebuilt', !/commut|morning/i.test(commute.headline) && commute.headline.length > 0, commute.headline);
  check('a pick named after commuters is removed, the next one kept', commute.win_first.length === 1 && commute.win_first[0].segment === 'Indie pop listeners', JSON.stringify(commute.win_first.map(w => w.segment)));
  check('time-of-day tactics stay, a commute-corridor channel goes', commute.win_first[0].why === 'Morning drive-thru rewards work here.'
    && commute.win_first[0].channels.join('|') === 'Morning drive time radio placements', JSON.stringify(commute.win_first[0]));
  check('each removal is a warning naming the descriptor', commuteWarnings.some(x => /"morning commuters"/i.test(x)) && commuteWarnings.some(x => /"late-night crowds"/i.test(x))
    && commuteWarnings.some(x => /"early risers"/i.test(x)), JSON.stringify(commuteWarnings));

  const abbrev = assembleBrief(rawBrief(run, {
    summary: 'Pop-ups near St. Marks Place suit them. They are wealthy.',
  }), run.ctx, []);
  check('an abbreviation does not split a sentence', abbrev.summary === 'Pop-ups near St. Marks Place suit them.', abbrev.summary);

  const parts = [];
  const p = assembleBrief(rawBrief(run, {
    headline: 'Win affluent Dunkin fans',
    rival_owned_segments: [
      { rival_id: run.rival, domain: 'artist', segment: 'Affluent commuters', confidence: 'high', insight: 'A lead.', evidence: [run.artist[0]] },
      { rival_id: run.rival, domain: 'artist', segment: 'Indie pop listeners', confidence: 'high', insight: 'A clear lead. Fans are budget minded.', evidence: [run.artist[0]] },
    ],
    win_first: [
      { rank: 1, segment: 'Wealthy suburbanites', why: 'x', campaign_hook: 'y', channels: [], evidence: [run.artist[0]] },
      { rank: 2, segment: 'Indie pop listeners', why: 'The widest gap.', campaign_hook: 'Playlist takeovers.', channels: ['Ads for budget shoppers', 'Creator partnerships'], evidence: [run.artist[0]] },
    ],
  }), run.ctx, parts);
  check('a headline that names a trait is rebuilt from the top segment', /leads Starbucks in Indie pop listeners/.test(p.headline) && !/affluent/i.test(p.headline), p.headline);
  check('a segment named after a trait is dropped', p.rival_owned_segments.length === 1 && p.rival_owned_segments[0].segment === 'Indie pop listeners', JSON.stringify(p.rival_owned_segments.map(s => s.segment)));
  check('a sentence inside a kept segment is dropped', p.rival_owned_segments[0].insight === 'A clear lead.', p.rival_owned_segments[0].insight);
  check('a win-first pick named after a trait is dropped and the ranks close up', p.win_first.length === 1 && p.win_first[0].rank === 1 && p.win_first[0].segment === 'Indie pop listeners', JSON.stringify(p.win_first.map(w => [w.rank, w.segment])));
  check('a channel tag that names a trait is dropped', JSON.stringify(p.win_first[0].channels) === '["Creator partnerships"]', JSON.stringify(p.win_first[0].channels));
  check('dropped picks and segments are noted in warnings', parts.some(x => /Removed a win-first pick/.test(x)) && parts.some(x => /Removed a segment/.test(x)), JSON.stringify(parts));
  check('no em or en dash in the warnings or the rebuilt headline', !/[\u2013\u2014]/.test(parts.join(' ') + p.headline));
  console.warn = origWarn;

  console.log('provenance');
  const clean = assembleBrief(rawBrief(run), run.ctx, []);
  check('the brief counts the Qloo data points it cites', clean.provenance.data_points === 1 + clean.geo_hotspots.length && clean.provenance.dropped === 0,
    JSON.stringify(clean.provenance));
  const invented = assembleBrief(rawBrief(run, {
    win_first: [{ rank: 1, segment: 'Indie pop listeners', why: 'x', campaign_hook: 'y', channels: [], evidence: [run.artist[0], 'e999', 'c999'] }],
    geo_hotspots: [{ ref: 'c998', label: 'x', note: 'y' }],
  }), run.ctx, []);
  check('citations the model invented are dropped and counted', invented.provenance.dropped === 3
    && invented.win_first[0].evidence.length === 1, JSON.stringify(invented.provenance));
  check('each Qloo endpoint the run called is counted', run.ctx.calls.search === 3 && run.ctx.calls.insights >= 1
    && run.ctx.calls.cross_scoring === 1 && run.ctx.calls.heatmap === 2, JSON.stringify(run.ctx.calls));

  {
  console.log('refs in the narration');
  const ctx = run.ctx;
  const cellRef = [...ctx.refs.entries()].find(([, v]) => v.kind === 'cell')[0];
  const cellName = (() => { const c = ctx.refs.get(cellRef); const g = ctx.geo[c.rival_id]; const hit = [...g.hotspots, ...g.our_strongest].find(x => x.geohash === c.geohash); return hit.label || hit.neighborhood || hit.area; })();
  const cityRef = [...ctx.refs.entries()].find(([, v]) => v.kind === 'locality' && ctx.localities.get(v.id)?.name)[0];
  const n = t => nameRefs(ctx, t);
  const cases = [
    ['Starbucks is b1 and Dunkin is b2.', 'Starbucks and Dunkin.'],
    ['Starbucks (b1) against Dunkin (b2).', 'Starbucks against Dunkin.'],
    ['Comparing b1 and b2 in music.', "Comparing Starbucks and Dunkin' in music."],
    ['Starbucks has ref b1.', 'Starbucks.'],
    ['The closest rival is b2.', "The closest rival is Dunkin'."],
    [run.artist[0] + ' leads the music gap.', run.artist[1] + ' leads the music gap.'],
    ['The widest cells are ' + cellRef + ' and c999.', 'The widest cells are ' + cellName + '.'],
    ['Using ref ' + cityRef + ' for the city.', 'Using ' + ctx.localities.get(ctx.refs.get(cityRef).id).name + ' for the city.'],
    ['Top picks (e31, c2, b1) look strong.', 'Top picks look strong.'],
    ['No refs here, e.g. a b-side or c-suite.', 'No refs here, e.g. a b-side or c-suite.'],
  ];
  for (const [input, want] of cases) check('narration: ' + JSON.stringify(input), n(input) === want, JSON.stringify(n(input)));
  check('no ref token is left in any case', cases.every(([input]) => !/\b[beclf]\d{1,3}\b/.test(n(input))));
  }

  {
  console.log('follow the lead');
  const lead = await context();
  const { ctx } = lead;
  const wrong = await tools.executeTool(ctx, 'follow_lead', { entity_ref: lead.brand });
  check('follow_lead takes only an entity ref from an audience gap', !wrong.ok && /entity ref/.test(wrong.error), wrong.error);
  const before = ctx.calls.insights || 0;
  const followed = await tools.executeTool(ctx, 'follow_lead', { entity_ref: lead.artist[0] });
  check('follow_lead returns music, places, brands and TV for the followed entity', followed.ok
    && ['music', 'places', 'brands', 'TV'].every(k => followed.result[k]?.length > 0) && followed.result.lead === lead.artist[1], JSON.stringify(followed.result).slice(0, 200));
  check('one Qloo insights call per domain, scoped to the run\'s city for places', ctx.calls.insights - before === 4 && followed.result.city === 'New York', JSON.stringify(ctx.calls));
  check('its rows carry f refs and whole-point affinities', Object.values(followed.result).filter(Array.isArray).flat()
    .filter(r => Array.isArray(r)).every(r => /^f\d+$/.test(r[0]) && Number.isInteger(r[2])));
  check('our brand and the rival are never lead results', ![...ctx.lead.index.keys()].some(id => ctx.pairBrands.has(id)));
  const again = await tools.executeTool(ctx, 'follow_lead', { entity_ref: lead.artist[0] });
  check('follow_lead runs once per brief', !again.ok && /once/.test(again.error), again.error);
  check('the trace label says it follows the lead', /^Following the lead: what .+ fans also love in music, places, brands and TV, with Qloo insights$/
    .test(tools.describeCall(ctx, 'follow_lead', { entity_ref: lead.artist[0] })), tools.describeCall(ctx, 'follow_lead', { entity_ref: lead.artist[0] }));

  const rows = ['music', 'brands'].map(k => followed.result[k][0]);
  const f1 = rows[0][0];
  const f2 = rows[1][0];
  const leadWarnings = [];
  const lb = assembleBrief(rawBrief(lead, {
    rival_owned_segments: [{ rival_id: lead.rival, domain: 'artist', segment: 'Indie pop listeners', confidence: 'high', insight: 'x', evidence: [lead.artist[0], f1] }],
    win_first: [
      { rank: 1, segment: 'Fans of ' + lead.artist[1], why: 'x', campaign_hook: 'y', channels: [], evidence: [lead.artist[0], f1, f2, 'f999'] },
      { rank: 2, segment: 'Indie pop listeners', why: 'x', campaign_hook: 'y', channels: [], evidence: [lead.artist[0]] },
    ],
  }), ctx, leadWarnings);
  const w1 = lb.win_first[0];
  check('a win-first pick cites lead results, and the server attaches their Qloo numbers', w1.evidence.filter(e => e.kind === 'lead').length === 2
    && w1.evidence.filter(e => e.kind === 'lead').every(e => e.affinity === ctx.lead.index.get(e.entity_id).affinity && typeof e.affinity === 'number'));
  check('the "Lead followed" note sits under that pick, with the followed entity and its gap', w1.lead?.name === lead.artist[1]
    && w1.lead.gap === ctx.lead.seed.gap && w1.lead.found.map(f => f.name).join() === [rows[0][1], rows[1][1]].join()
    && !lb.win_first[1].lead, JSON.stringify(w1.lead));
  check('a lead result cited as a rival gap is dropped, and so is an unknown f ref', lb.rival_owned_segments[0].evidence.every(e => e.kind === 'entity')
    && lb.provenance.dropped === 2 && leadWarnings.some(x => /follow_lead citation/.test(x)) && leadWarnings.some(x => /f999/.test(x)), JSON.stringify(leadWarnings));
  check('lead results count as data points', lb.provenance.data_points === 3 + lb.geo_hotspots.length, JSON.stringify(lb.provenance));
  const unused = [];
  assembleBrief(rawBrief(lead), ctx, unused);
  check('a followed lead that no pick uses is noted in the warnings', unused.some(x => /followed the lead/.test(x)), JSON.stringify(unused));
  check('narration names an f ref', nameRefs(ctx, 'Fans also love ' + f1 + '.') === 'Fans also love ' + rows[0][1] + '.', nameRefs(ctx, 'Fans also love ' + f1 + '.'));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
