// Outbound — background run processor.
//
// startRun(runId) is fire-and-forget: it flips the run to 'running', walks the
// pipeline, persists leads, and flips the run to 'done' (or 'error'). It never
// blocks the HTTP request that started it (the endpoint returns the run id
// immediately) and it never throws to the caller. Each company is wrapped in
// try/catch so one bad company cannot fail the whole run.
//
// Pipeline: discover -> (per company) people -> contact -> score -> draft ->
// persist. Anything below SCORE_THRESHOLD is dropped.

const store = require('./store');
const { getProvider, OutboundConfigError, rolesForStage } = require('./provider');
const { structuredCall, draftCall } = require('./ai');
const { getAgentPrompt } = require('./agentPrompt');
const { sanitizeCopy, sanitizeCopyDeep } = require('../lib/sanitizeText');
const { sleep } = require('../lib/retry');

const SCORE_THRESHOLD = 60;   // drop candidates scoring below this
const HARD_CAP = 25;          // never process more than this many companies

// Each company costs one search plus two model calls. At the hard cap that is
// 75 calls, so we space companies out to stay under provider per-minute limits.
// withRetry() in lib/retry.js is the backstop when we still get a 429.
const COMPANY_GAP_MS = 750;

// Kick off a run in the background. Returns immediately.
function startRun(runId) {
  // Defer to the next tick so the HTTP handler can respond first.
  setImmediate(() => {
    runPipeline(runId).catch(err => {
      console.error('[outbound.pipeline] unhandled run error:', err);
      try { store.updateRun(runId, { status: 'error', error_message: safeMsg(err) }); } catch (_) {}
    });
  });
}

async function runPipeline(runId) {
  const run = store.getRun(runId);
  if (!run) return;
  store.updateRun(runId, { status: 'running' });

  const params = run.params || {};
  const brief = params.brief || '';
  const targetCount = clampCount(params.targetCount);
  const regionHints = params.regionHints || '';

  const provider = getProvider();

  let candidates;
  try {
    candidates = await provider.discoverCompanies(brief, { targetCount, regionHints });
  } catch (err) {
    // Config errors (missing/invalid SERPER key) surface as a clean run error.
    const msg = err instanceof OutboundConfigError ? err.message : `Discovery failed: ${safeMsg(err)}`;
    store.updateRun(runId, { status: 'error', error_message: msg });
    return;
  }

  const totalFound = candidates.length;
  let kept = 0;

  let firstCompany = true;
  for (const company of candidates) {
    if (!firstCompany) await sleep(COMPANY_GAP_MS);
    firstCompany = false;
    try {
      const lead = await buildLead(provider, brief, company);
      if (!lead) continue;                       // dropped below threshold
      store.insertLead(runId, lead);
      kept += 1;
    } catch (err) {
      console.warn('[outbound.pipeline] company failed:', company?.company, '-', safeMsg(err));
      // continue on partial failure
    }
  }

  store.updateRun(runId, { status: 'done', total_found: totalFound, total_kept: kept });
}

// Build one persisted-shaped lead from a company candidate: person -> contact ->
// score -> draft. Returns null when the company is not a lead: no verified
// current person (rule 1), no usable contact (rule 2), or a below-threshold score.
async function buildLead(provider, brief, company) {
  // People + contact (never fabricated). findPeople only returns a person whose
  // current employment at the company is verified (see provider.findPeople).
  const roles = rolesForStage(company.stage_size);
  let person = null, contact = null;
  try {
    const people = await provider.findPeople(company.company, roles);
    person = people[0] || null;
  } catch (err) {
    console.warn('[outbound.pipeline] findPeople failed:', company.company, '-', safeMsg(err));
  }
  // Rule 1 + 2: no verified current person means the company is not a lead.
  if (!person) return null;

  try { contact = await provider.findContact(person); } catch (_) { contact = null; }
  // Rule 2: require a usable way to reach them (a valid profile URL or a found
  // email). No reachable contact means the company is dropped, never shown blank.
  if (!hasUsableContact(person, contact)) return null;

  // Score on the rubric (fit 30 / pain 30 / reachability 20 / timing 20).
  const scoreResult = await scoreCandidate(brief, company, person);
  const score = Number.isFinite(scoreResult?.score) ? scoreResult.score : 0;
  if (score < SCORE_THRESHOLD) return null;

  // Draft (we always have a verified someone to write to by this point).
  const drafted = await draftMessage(company, person, contact);
  const draft = drafted?.text || null;
  const confidence = drafted?.confidence || scoreResult?.confidence || null;

  return {
    company: company.company,
    domain: company.domain,
    category: company.category,
    stage_size: company.stage_size,
    region: company.region,
    trigger: company.trigger,
    trigger_url: company.trigger_url,
    trigger_at: company.trigger_date || null,
    score,
    score_breakdown: scoreResult?.score_breakdown || {},
    why_now: scoreResult?.why_now || null,
    person_name: person?.person_name || null,
    person_title: person?.person_title || null,
    person_seniority: person?.person_seniority || null,
    channel: contact?.channel || person?.channel || 'linkedin',
    handle_or_email: contact?.handle_or_email || person?.profileUrl || null,
    contact_status: contact?.contact_status || 'manual',
    backup_channel: contact?.backup_channel || null,
    draft,
    confidence,
  };
}

// Anthropic scoring. Returns { score, score_breakdown, why_now, confidence }.
// If the model is unavailable, returns a neutral score so the pipeline degrades
// rather than dropping everything.
async function scoreCandidate(brief, company, person) {
  const system = 'You score outbound leads for Nivaria, a competitor-intelligence app for SaaS '
    + 'sales and product-marketing teams. Score each candidate 0-100 as the sum of: fit (0-30), '
    + 'pain (0-30), reachability (0-20), timing (0-20). Be strict. Return JSON only. Never use '
    + 'em-dashes, en-dashes, or a connecting "+"; write "and" instead.';
  const user = 'ICP brief:\n' + String(brief || '').slice(0, 1500)
    + '\n\nToday is ' + new Date().toISOString().slice(0, 10) + '. Weight timing on how recent the '
    + 'trigger is: a trigger from the last few days scores near full timing, one older than about 90 '
    + 'days scores near zero.'
    + '\n\nCandidate:\n' + JSON.stringify({
      company: company.company, category: company.category, stage_size: company.stage_size,
      region: company.region, trigger: company.trigger, trigger_url: company.trigger_url,
      trigger_date: company.trigger_date || null,
      person: person ? { title: person.person_title, seniority: person.person_seniority } : null,
    })
    + '\n\nReturn: { "score": int 0-100, "score_breakdown": { "fit": int, "pain": int, '
    + '"reachability": int, "timing": int }, "why_now": string (one sentence, why reach out now), '
    + '"confidence": "high"|"medium"|"low" }';

  const parsed = await structuredCall({ system, user, maxTokens: 700 });
  if (!parsed) {
    // No AI available: neutral pass-through so discovery is still usable.
    return { score: SCORE_THRESHOLD, score_breakdown: {}, why_now: company.trigger || null, confidence: 'low' };
  }
  return sanitizeCopyDeep({
    score: clampScore(parsed.score),
    score_breakdown: parsed.score_breakdown || {},
    why_now: parsed.why_now || null,
    confidence: normalizeConfidence(parsed.confidence),
  });
}

// Anthropic drafting with the outbound agent as the system prompt. Runs the
// output through the no-dash / no-connector sanitizer before returning.
async function draftMessage(company, person, contact) {
  const channel = contact?.channel || person?.channel || 'linkedin';
  const user = 'Write one outreach message.\n'
    + `Channel: ${channel}\n`
    + `Company: ${company.company}\n`
    + `Category: ${company.category || 'unknown'}\n`
    + `Trigger: ${company.trigger || 'n/a'}\n`
    + `Trigger source: ${company.trigger_url || 'n/a'}\n`
    + `Person: ${person?.person_name || 'unknown'} (${person?.person_title || 'unknown title'})\n`;
  const text = await draftCall({ system: getAgentPrompt(), user, maxTokens: 700 });
  if (!text) return null;
  return { text: sanitizeCopy(text), confidence: undefined };
}

// Re-run drafting for a single existing lead (redraft endpoint). Optional new
// channel/angle. Returns the sanitized draft text or null.
async function redraftLead(lead, { channel, angle } = {}) {
  const ch = channel || lead.channel || 'linkedin';
  let user = 'Write one outreach message.\n'
    + `Channel: ${ch}\n`
    + `Company: ${lead.company}\n`
    + `Category: ${lead.category || 'unknown'}\n`
    + `Trigger: ${lead.trigger || 'n/a'}\n`
    + `Trigger source: ${lead.trigger_url || 'n/a'}\n`
    + `Person: ${lead.person_name || 'unknown'} (${lead.person_title || 'unknown title'})\n`;
  if (angle) user += `Angle to emphasize: ${String(angle).slice(0, 300)}\n`;
  const text = await draftCall({ system: getAgentPrompt(), user, maxTokens: 700 });
  if (!text) return null;
  return { text: sanitizeCopy(text), channel: ch };
}

// ── helpers ──────────────────────────────────────────────────────────────────────

function clampCount(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < 1) return 10;
  return Math.min(v, HARD_CAP);
}
function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}
function normalizeConfidence(c) {
  const v = String(c || '').toLowerCase();
  return ['high', 'medium', 'low'].includes(v) ? v : 'low';
}
function safeMsg(err) {
  return String(err?.message || err || 'unknown error').slice(0, 500);
}

// A usable contact is a valid profile URL or a found email. Anything else (empty,
// "manual" with no link) means the company has no reachable contact and is dropped.
function isUsableContactValue(v) {
  if (!v) return false;
  const s = String(v).trim();
  return /^https?:\/\/\S+\.\S+/.test(s) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function hasUsableContact(person, contact) {
  return isUsableContactValue(contact?.handle_or_email)
    || isUsableContactValue(contact?.profileUrl)
    || isUsableContactValue(person?.profileUrl);
}

module.exports = { startRun, redraftLead, SCORE_THRESHOLD, HARD_CAP };
