// What a stored brief looks like on its way to a reader. Applied when a run is
// served (tasteRuns.hydrate, tasteShares.sharedRun, tasteRuns.featuredRows),
// so briefs stored before a fix read right too, and also when a new brief is
// assembled.
//
// plainWarnings: the server's checks on the model's draft are stored raw (a
// citation the model invented, such as "e1|^{rival_id:", is kept for the
// server log), but a reader only ever sees plain sentences: "1 claim in
// Alternative Rock and Pop Punk couldn't be matched to Qloo data and was
// removed." A check this module does not know becomes a generic sentence,
// never the raw text.
//
// restoreAmpersands: a model told to write "and" instead of a connector "+"
// also turned Qloo's "R&B" into "R and B". An initialism the run's own Qloo
// data spells with "&" (R&B, H&M, M&M'S) is put back as written. Ordinary
// pairs ("coffee and tea") are left alone: that is plain English.

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

function plainWarnings(raw) {
  const list = Array.isArray(raw) ? raw.filter(w => typeof w === 'string') : [];
  const claims = new Map();      // where -> count
  const notGaps = new Map();
  let hotspots = 0;
  const out = [];
  const was = n => (n === 1 ? 'was' : 'were');
  for (const w of list) {
    let m;
    if ((m = /^Dropped unresolved citation .* in (?:segment|win_first) "(.*)"$/s.exec(w))) {
      claims.set(m[1], (claims.get(m[1]) || 0) + 1);
    } else if ((m = /^Dropped follow_lead citation .* in (?:segment|win_first) "(.*)", which needs a gap between the brands$/s.exec(w))) {
      notGaps.set(m[1], (notGaps.get(m[1]) || 0) + 1);
    } else if ((m = /^Dropped segment "(.*)" with no resolvable evidence$/s.exec(w))) {
      out.push(`The segment ${m[1]} had no claims Qloo data could back, so it was removed.`);
    } else if (/^Dropped hotspot /.test(w)) {
      hotspots += 1;
    } else if ((m = /^Removed a sentence that described a trait no tool returned \("(.*)"\)$/s.exec(w))) {
      out.push(`A sentence describing people as "${m[1]}" was removed: Qloo data doesn't describe people that way.`);
    } else if (w === 'Removed a win-first pick named after that trait') {
      out.push('A pick named after that description was removed too.');
    } else if (w === 'Removed a segment named after that trait') {
      out.push('A segment named after that description was removed too.');
    } else if ((m = /^The agent followed the lead on (.*) but built no win-first pick on it$/s.exec(w))) {
      out.push(`The agent followed the lead on ${m[1]} but didn't build a pick on it.`);
    } else if ((m = /^The brief named no hotspots for (.*), so the map lists the cells where it leads most$/s.exec(w))) {
      out.push(`The brief named no places on the map for ${m[1]}, so the map shows where it leads most.`);
    } else {
      out.push(`One part of the draft didn't pass a check and was changed.`);
    }
  }
  for (const [name, n] of claims) out.unshift(`${plural(n, 'claim', 'claims')} in ${name} couldn't be matched to Qloo data and ${was(n)} removed.`);
  for (const [name, n] of notGaps) out.push(`${plural(n, 'claim', 'claims')} in ${name} didn't compare the two brands and ${was(n)} removed.`);
  if (hotspots) out.push(`${plural(hotspots, 'place', 'places')} on the map couldn't be matched to Qloo data and ${was(hotspots)} removed.`);
  return [...new Set(out)];
}

// Initialisms with "&" that are names whatever the run returned.
const KNOWN = ['R&B', 'H&M', 'AT&T', 'P&G', 'A&W', 'M&M\'S'];
// An "&" between short parts: R&B, AT&T, M&M'S (not "Coffee & Tea").
const INITIALISM = /\b([A-Za-z]{1,3})\s*&\s*([A-Za-z]{1,3}(?:'[A-Za-z])?)(?![A-Za-z])/g;

function collectStrings(value, out, depth = 0) {
  if (depth > 8 || value == null) return out;
  if (typeof value === 'string') { if (value.includes('&')) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return out; }
  if (typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  return out;
}

// [pattern, replacement] for every "&" initialism in the run's own data.
function ampersandFixes(...sources) {
  const tokens = new Set(KNOWN);
  for (const s of sources.flatMap(src => collectStrings(src, []))) {
    for (const m of s.matchAll(INITIALISM)) tokens.add(m[1] + '&' + m[2]);
  }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...tokens].map(t => {
    const [a, b] = t.split('&');
    return [new RegExp('\\b' + esc(a) + '\\s+and\\s+' + esc(b) + '(?![A-Za-z])', 'gi'), t];
  });
}

function fixStrings(value, fixes, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string') return fixes.reduce((s, [re, t]) => s.replace(re, t), value);
  if (Array.isArray(value)) return value.map(v => fixStrings(v, fixes, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fixStrings(v, fixes, depth + 1);
    return out;
  }
  return value;
}

// A copy of the brief with Qloo's ampersand names put back.
function restoreAmpersands(brief, data) {
  if (!brief || typeof brief !== 'object') return brief;
  return fixStrings(brief, ampersandFixes(data, brief));
}

module.exports = { plainWarnings, restoreAmpersands };
