// Phase 8 — live end-to-end runner for generated response playbooks.
//
// Exercises the real Sonnet pipeline against the running dev server. Tests:
//
//   Test 1 — defaults: user with no voice profile produces readable output
//            that follows the human-tone rules.
//   Test 2 — formal vs casual side-by-side: same change, two profiles.
//   Test 3 — avoid_phrases respected across 5 regeneration attempts.
//   Test 4 — em-dashes / en-dashes appear zero times across 10 generations.
//   Test 5 — regeneration produces meaningfully different output.
//   Test 6 — voice_sample injection: distinctive sample is picked up.
//
// How to run:
//   1. Server must be running on http://localhost:3000
//   2. node test-phase8-live.js
//
// Output: phase8-report.json + console summary. Re-running is safe — the
// script snapshots the user's existing voice profile at the start and
// restores it at the end.

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const http = require('http');

const BASE = process.env.FORESIGHT_BASE || 'http://localhost:3000';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required. Aborting.');
  process.exit(1);
}

// ── DB read: snag the demo user's api_key without a session round-trip ─────

async function loadApiKeyFromDb() {
  if (process.env.FORESIGHT_API_KEY) return process.env.FORESIGHT_API_KEY;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dbBuf = fs.readFileSync(path.join(__dirname, 'data', 'competitor-shadow.db'));
  const sql = new SQL.Database(dbBuf);
  const r = sql.exec('SELECT api_key FROM users WHERE id = 1');
  return r[0]?.values?.[0]?.[0];
}

function makeRequest(apiKey) {
  return (method, urlPath, body) => new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      method,
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key':    apiKey,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        const isJson = (res.headers['content-type'] || '').includes('application/json');
        let payload = chunks;
        try { if (isJson) payload = JSON.parse(chunks); } catch (_) {}
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error(payload?.error || `HTTP ${res.statusCode}`),
            { status: res.statusCode, payload }));
        }
        resolve(payload);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Bookkeeping ──────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const findings = [];
function ok(label) { console.log(`  ✓ ${label}`); pass++; findings.push({ ok: true,  label }); }
function bad(label, detail) { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; findings.push({ ok: false, label, detail }); }
function section(title) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`); }

// ── Helpers ──────────────────────────────────────────────────────────────────

const DASH_RE = /[—–]/g;
function dashCount(text) { return (String(text || '').match(DASH_RE) || []).length; }
function lower(s) { return String(s || '').toLowerCase(); }
function tokens(s) { return lower(s).match(/[a-z]+/g) || []; }
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, A.size + B.size - inter);
}

// ── Profiles used across tests ───────────────────────────────────────────────

const PROFILES = {
  blank: {
    formality: null, contraction_style: null, opener_style: null, sentence_rhythm: null,
    sign_off_examples: '', voice_sample: '', avoid_phrases: '',
  },
  casual: {
    formality: 'casual', contraction_style: 'always', opener_style: 'direct', sentence_rhythm: 'short_punchy',
    sign_off_examples: 'Cheers,\nEddy\n\nThanks,\nE',
    voice_sample: '',
    avoid_phrases: '',
  },
  formal: {
    formality: 'formal', contraction_style: 'never', opener_style: 'context-first', sentence_rhythm: 'measured',
    sign_off_examples: 'Best regards,\nEdiong Udotong\n\nSincerely,\nEdiong',
    voice_sample: '',
    avoid_phrases: '',
  },
  avoidance: {
    formality: 'balanced', contraction_style: 'sometimes', opener_style: 'direct', sentence_rhythm: 'mixed',
    sign_off_examples: 'Thanks,\nE',
    voice_sample: '',
    avoid_phrases: 'delve, leverage, synergy, circle back, touch base, in today\'s landscape, navigate, robust',
  },
  voiceSample: {
    formality: 'casual', contraction_style: 'always', opener_style: 'direct', sentence_rhythm: 'short_punchy',
    sign_off_examples: 'E',
    // Highly distinctive: starts with "Heads up.", uses fragments, lowercase "tbh",
    // closes "Worth a chat?", sign-off "-- E".
    voice_sample:
`Heads up. Saw the BambooHR pricing drop. tbh this changes the math for the Q2 deal in flight. their seat unlock at $34 takes our main objection off the table.

want me to pull together a 1-pager on how we still beat them on the integrations story before tomorrow's call? worth a chat?

-- E`,
    avoid_phrases: '',
  },
};

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const apiKey = await loadApiKeyFromDb();
  if (!apiKey) { console.error('Could not resolve API key from DB or env'); process.exit(1); }
  const req = makeRequest(apiKey);

  const setProfile  = (p)  => req('PUT', '/api/user/voice-profile', p);
  const getProfile  = ()   => req('GET', '/api/user/voice-profile');
  const findHigh    = async () => {
    const data = await req('GET', '/api/changes?limit=20&threat=high');
    if (!data.changes || data.changes.length === 0) throw new Error('No high-threat changes in DB');
    return data.changes.find(c => c.is_meaningful === 1 || c.is_meaningful == null) || data.changes[0];
  };
  const generate    = (id) => req('POST', `/api/playbooks/changes/${id}/generate`);
  const getPbs      = (id) => req('GET',  `/api/playbooks/changes/${id}`);
  const regen       = (id) => req('POST', `/api/playbooks/${id}/regenerate`);

  let originalProfile = null;

  try {
    const existing = await getProfile();
    originalProfile = existing.exists ? { ...existing.profile } : null;
    console.log(`Existing voice profile: ${originalProfile ? 'present (will restore at end)' : 'none'}`);

    const change = await findHigh();
    console.log(`Target change#${change.id}: ${change.competitor_name} — "${(change.headline || '').slice(0, 80)}"`);

    const fullReport = { changeId: change.id, competitor: change.competitor_name, headline: change.headline, tests: {} };

    // ── Test 1: defaults ───────────────────────────────────────────────────
    section('Test 1 — defaults: user with no voice profile');
    await setProfile(PROFILES.blank);
    await generate(change.id);
    const t1 = (await getPbs(change.id)).playbooks;
    fullReport.tests.test1 = { profile: PROFILES.blank, playbooks: t1 };
    if (t1.length >= 1 && t1.every(p => p.body && p.body.length > 30)) {
      ok(`defaults produced ${t1.length} variants with readable bodies`);
    } else {
      bad('defaults produced empty/missing bodies', JSON.stringify(t1.map(p => ({ t: p.message_type, len: p.body?.length || 0 }))));
    }
    const taboos = ['i hope this email finds you well', 'i trust this finds', 'just wanted to reach out', 'just wanted to touch base'];
    const taboosHit = [];
    for (const p of t1) {
      const blob = lower((p.subject_line || '') + '\n' + (p.body || ''));
      for (const t of taboos) if (blob.includes(t)) taboosHit.push({ variant: p.message_type, phrase: t });
    }
    if (taboosHit.length === 0) ok('defaults: no banned-opener phrases present');
    else bad('defaults: banned-opener phrases present', JSON.stringify(taboosHit));

    // ── Test 2: formal vs casual ───────────────────────────────────────────
    section('Test 2 — formal vs casual on same change');
    await setProfile(PROFILES.casual);
    await generate(change.id);
    const t2casual = (await getPbs(change.id)).playbooks;
    await setProfile(PROFILES.formal);
    await generate(change.id);
    const t2formal = (await getPbs(change.id)).playbooks;
    fullReport.tests.test2 = { casual: t2casual, formal: t2formal };

    const contractionsRe = /[a-z]'(t|s|re|ve|ll|d|m)\b/gi;
    const countContr = (rows) => rows.reduce((n, p) => n + ((p.body || '').match(contractionsRe) || []).length, 0);
    const casualContr = countContr(t2casual);
    const formalContr = countContr(t2formal);
    if (casualContr > formalContr) ok(`casual has more contractions (${casualContr}) than formal (${formalContr})`);
    else bad(`casual did not produce more contractions than formal`, `casual=${casualContr} formal=${formalContr}`);

    const variants = ['slack_to_team', 'email_to_prospect', 'followup_email'];
    for (const v of variants) {
      const c = t2casual.find(p => p.message_type === v)?.body || '';
      const f = t2formal.find(p => p.message_type === v)?.body || '';
      if (c && f) {
        const sim = jaccard(tokens(c), tokens(f));
        if (sim < 0.75) ok(`${v}: casual/formal bodies meaningfully differ (jaccard=${sim.toFixed(3)})`);
        else bad(`${v}: casual/formal bodies too similar`, `jaccard=${sim.toFixed(3)}`);
      }
    }

    // ── Test 3: avoid_phrases over 5 regens ────────────────────────────────
    section('Test 3 — avoid_phrases respected across 5 regenerations');
    await setProfile(PROFILES.avoidance);
    await generate(change.id);
    let pbs = (await getPbs(change.id)).playbooks;
    let target = pbs.find(p => p.message_type === 'email_to_prospect') || pbs[0];
    const regenSamples = [target];
    for (let i = 0; i < 4; i++) {
      const r = await regen(target.id);
      regenSamples.push(r.playbook);
    }
    fullReport.tests.test3 = { profile: PROFILES.avoidance, samples: regenSamples };

    const forbid = ['delve', 'leverage', 'synergy', 'circle back', 'touch base', "in today's landscape", 'navigate', 'robust'];
    const hits3 = [];
    for (let i = 0; i < regenSamples.length; i++) {
      const s = regenSamples[i];
      const blob = lower((s.subject_line || '') + '\n' + (s.body || ''));
      for (const phrase of forbid) {
        const re = new RegExp(`(^|[^a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
        if (re.test(blob)) hits3.push({ regen_index: i, phrase });
      }
    }
    if (hits3.length === 0) ok(`5 regens × 8 forbidden phrases = ${5*8} checks, all clean`);
    else bad(`avoid_phrases violations across 5 regens`, JSON.stringify(hits3));

    // ── Test 4: 0 em/en-dashes across 10 generations ───────────────────────
    section('Test 4 — 0 em-dashes / en-dashes across 10 generations');
    await setProfile(PROFILES.casual);
    let totalDashes = 0;
    const dashSamples = [];
    await generate(change.id);
    pbs = (await getPbs(change.id)).playbooks;
    for (const p of pbs) {
      const d = dashCount(p.subject_line) + dashCount(p.body);
      totalDashes += d;
      dashSamples.push({ message_type: p.message_type, dashes: d, body_preview: (p.body || '').slice(0, 200) });
    }
    await generate(change.id);
    pbs = (await getPbs(change.id)).playbooks;
    for (const p of pbs) {
      const d = dashCount(p.subject_line) + dashCount(p.body);
      totalDashes += d;
      dashSamples.push({ message_type: p.message_type, dashes: d, body_preview: (p.body || '').slice(0, 200) });
    }
    const regenTarget = pbs.find(p => p.message_type === 'slack_to_team');
    for (let i = 0; i < 4; i++) {
      const r = await regen(regenTarget.id);
      const d = dashCount(r.playbook.subject_line) + dashCount(r.playbook.body);
      totalDashes += d;
      dashSamples.push({ message_type: r.playbook.message_type, dashes: d, body_preview: (r.playbook.body || '').slice(0, 200) });
    }
    fullReport.tests.test4 = { total_generations: dashSamples.length, total_dashes_after_strip: totalDashes, samples: dashSamples };
    if (totalDashes === 0) ok(`${dashSamples.length} generations: 0 em/en-dashes in persisted output`);
    else bad(`${totalDashes} em/en-dashes leaked through across ${dashSamples.length} generations`, JSON.stringify(dashSamples.filter(s => s.dashes > 0)));

    // ── Test 5: regenerations differ meaningfully ──────────────────────────
    section('Test 5 — regenerations differ meaningfully');
    await setProfile(PROFILES.casual);
    await generate(change.id);
    pbs = (await getPbs(change.id)).playbooks;
    target = pbs.find(p => p.message_type === 'email_to_prospect');
    const originalBody = target.body;
    const regen5 = await regen(target.id);
    const sim5 = jaccard(tokens(originalBody), tokens(regen5.playbook.body));
    fullReport.tests.test5 = {
      original_body:    originalBody,
      regenerated_body: regen5.playbook.body,
      jaccard_similarity: sim5,
    };
    if (sim5 < 0.75) ok(`regen meaningfully differs (jaccard=${sim5.toFixed(3)})`);
    else bad(`regen too similar to original`, `jaccard=${sim5.toFixed(3)}`);

    // ── Test 6: voice_sample injection ─────────────────────────────────────
    section('Test 6 — voice_sample injection picks up distinctive patterns');
    await setProfile(PROFILES.voiceSample);
    await generate(change.id);
    pbs = (await getPbs(change.id)).playbooks;
    fullReport.tests.test6 = { profile: PROFILES.voiceSample, playbooks: pbs };

    // Fuzzy markers — the system prompt tells the model to mirror voice
    // texture without copying phrases verbatim, so an exact "tbh" match isn't
    // expected. We look for any of these signal patterns from the sample:
    //   1. opener pattern: "Heads up" or short imperative
    //   2. casual closer: subject or body uses "worth a …" (chat/quick/min)
    //   3. single-letter "E" sign-off on its own line (mirrors the sample)
    //   4. lowercase "tbh" abbreviation (sample-specific)
    //   5. short fragment opener (first "sentence" ≤4 words)
    const markerEvidence = [];
    for (const p of pbs) {
      const subj = p.subject_line || '';
      const body = p.body || '';
      const blob = lower(subj + '\n' + body);

      if (blob.includes('heads up'))    markerEvidence.push({ variant: p.message_type, marker: 'heads up' });
      if (/\bworth a\b/i.test(blob))    markerEvidence.push({ variant: p.message_type, marker: 'worth a [chat|quick|15]' });
      if (/\btbh\b/i.test(blob))        markerEvidence.push({ variant: p.message_type, marker: 'tbh' });
      // Standalone "E" closer on its own line (or final line) — mirrors sign-off sample
      if (/(^|\n)\s*E\s*$/m.test(body)) markerEvidence.push({ variant: p.message_type, marker: 'single-letter "E" sign-off' });
      // Short opener: first sentence is ≤4 words
      const first = body.split(/[.!?\n]/, 1)[0]?.trim() || '';
      if (first && first.split(/\s+/).length <= 4) markerEvidence.push({ variant: p.message_type, marker: `short opener ("${first}")` });
    }
    fullReport.tests.test6.marker_hits = markerEvidence;
    if (markerEvidence.length > 0) {
      ok(`voice_sample picked up — ${markerEvidence.length} markers across ${new Set(markerEvidence.map(e => e.variant)).size} variants`);
      for (const e of markerEvidence) console.log(`      • ${e.variant}: ${e.marker}`);
    } else {
      bad('voice_sample did not visibly influence output', 'no markers from sample appeared in any variant');
    }

    // ── Token cost summary ─────────────────────────────────────────────────
    section('Token cost — aggregate across all tests');
    const allPbs = [
      ...(fullReport.tests.test1?.playbooks || []),
      ...(fullReport.tests.test2?.casual    || []),
      ...(fullReport.tests.test2?.formal    || []),
      ...(fullReport.tests.test3?.samples   || []),
      // test4 is collected via dashSamples but those aren't full playbook rows
      ...(fullReport.tests.test6?.playbooks || []),
    ];
    let totalIn = 0, totalOut = 0, totalCost = 0;
    for (const p of allPbs) {
      totalIn  += p.ai_input_tokens  || 0;
      totalOut += p.ai_output_tokens || 0;
      totalCost += p.estimated_cost_usd || 0;
    }
    const perChangeCost = (() => {
      // Per-change cost = sum of the 3 variants generated for a single fresh run.
      const fresh = fullReport.tests.test1?.playbooks || [];
      return fresh.reduce((n, p) => n + (p.estimated_cost_usd || 0), 0);
    })();
    fullReport.tokens = {
      total_input_tokens:    totalIn,
      total_output_tokens:   totalOut,
      total_estimated_cost_usd: totalCost,
      per_change_cost_usd_3_variants: perChangeCost,
    };
    console.log(`  input=${totalIn} output=${totalOut} cost=$${totalCost.toFixed(4)}`);
    console.log(`  per-change (3 variants): $${perChangeCost.toFixed(4)}`);

    fs.writeFileSync(path.join(__dirname, 'phase8-report.json'), JSON.stringify(fullReport, null, 2));
    console.log(`\nWrote phase8-report.json`);
    console.log(`\nFinal score: ${pass} pass / ${fail} fail`);

    // Restore profile
    if (originalProfile) {
      await setProfile({
        formality:         originalProfile.formality,
        contraction_style: originalProfile.contraction_style,
        opener_style:      originalProfile.opener_style,
        sentence_rhythm:   originalProfile.sentence_rhythm,
        sign_off_examples: originalProfile.sign_off_examples || '',
        voice_sample:      originalProfile.voice_sample || '',
        avoid_phrases:     originalProfile.avoid_phrases || '',
      });
      console.log('Voice profile restored to original.');
    } else {
      await setProfile(PROFILES.blank);
      console.log('Voice profile cleared (no original to restore).');
    }

    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e.message);
    if (e.payload) console.error('payload:', JSON.stringify(e.payload).slice(0, 500));
    process.exit(2);
  }
})();
