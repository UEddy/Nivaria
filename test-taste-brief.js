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
const { assembleBrief } = require('./src/taste/agent');

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

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
