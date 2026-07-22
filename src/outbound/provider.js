// Outbound — lead data provider.
//
// The pipeline talks to a LeadDataProvider, never to a vendor directly, so a
// paid enrichment provider (Apollo, People Data Labs) can be dropped in for
// Phase 2 without touching the pipeline. Interface:
//
//   discoverCompanies(brief, opts) -> CompanyCandidate[]
//   findPeople(company, roles)     -> Person[]
//   findContact(person)            -> Contact
//
// Phase-1 concrete implementation: SearchFirstProvider. It uses a web-search API
// (Serper.dev) for discovery and people-finding, the Anthropic API to turn raw
// search results into structured candidates, and NEVER fabricates a contact:
// email finding is out of scope for Phase 1, so every contact comes back
// { contact_status: 'manual', profileUrl } for me to grab via the Chrome
// extension.
//
// A missing SERPER_API_KEY raises OutboundConfigError, which the pipeline turns
// into a clean run error (the app still boots and runs without the key).

const axios = require('axios');
const { structuredCall } = require('./ai');
const { withRetry, sleep } = require('../lib/retry');

// Pause between consecutive Serper searches in the discovery loop so one run
// does not burst past the provider's per-minute limit.
const SEARCH_GAP_MS = 400;

class OutboundConfigError extends Error {
  constructor(message) { super(message); this.name = 'OutboundConfigError'; }
}

// Stage -> the role we hunt for at that company size (from the agent spec).
const ROLE_MAP = {
  tiny:   ['Founder', 'CEO', 'Co-founder'],
  small:  ['Head of Product Marketing', 'Product Marketing', 'Founder'],
  growth: ['Competitive Intelligence', 'Product Marketing Manager', 'RevOps', 'Sales Enablement'],
  large:  ['Competitive Intelligence', 'Product Marketing Director', 'Revenue Operations'],
};

function rolesForStage(stage) {
  const key = String(stage || '').toLowerCase();
  if (/found|seed|pre-seed|tiny|1-10/.test(key)) return ROLE_MAP.tiny;
  if (/small|11-50|series a/.test(key)) return ROLE_MAP.small;
  if (/large|enterprise|500|series [d-z]/.test(key)) return ROLE_MAP.large;
  return ROLE_MAP.growth;
}

class SearchFirstProvider {
  constructor() {
    this.serperKey = process.env.SERPER_API_KEY || '';
    this.endpoint = 'https://google.serper.dev/search';
  }

  ensureConfigured() {
    if (!this.serperKey) {
      throw new OutboundConfigError(
        'Discovery is not configured. Set SERPER_API_KEY in Railway to enable lead discovery.'
      );
    }
  }

  // One Serper web search. Returns a compact array of { title, link, snippet }.
  // A 429 is retried with backoff (1s, 2s, 4s) before we give up on the query.
  async search(query, { num = 10, gl } = {}) {
    this.ensureConfigured();
    try {
      const body = { q: query, num };
      if (gl) body.gl = gl; // country bias, e.g. 'us'
      const resp = await withRetry(() => axios.post(this.endpoint, body, {
        headers: { 'X-API-KEY': this.serperKey, 'Content-Type': 'application/json' },
        timeout: 15000,
      }), { label: 'serper search' });
      const organic = Array.isArray(resp.data?.organic) ? resp.data.organic : [];
      return organic.map(r => ({ title: r.title || '', link: r.link || '', snippet: r.snippet || '' }));
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        throw new OutboundConfigError('Serper rejected the API key (check SERPER_API_KEY).');
      }
      // Transient search failure: return nothing rather than killing the run.
      console.warn('[outbound.provider] search failed for', JSON.stringify(query), '-', err?.message || err);
      return [];
    }
  }

  // ── Discover ─────────────────────────────────────────────────────────────────
  async discoverCompanies(brief, { targetCount = 10, regionHints = '' } = {}) {
    this.ensureConfigured();
    const gl = regionHintToGl(regionHints);

    // 1) Ask the model to expand the brief into concrete ICP/pain search queries.
    const queries = await this.buildQueries(brief, regionHints);

    // 2) Run the searches and aggregate results (deduped by link).
    const seen = new Set();
    const results = [];
    let first = true;
    for (const q of queries) {
      if (!first) await sleep(SEARCH_GAP_MS);
      first = false;
      const hits = await this.search(q, { num: 10, gl });
      for (const h of hits) {
        if (!h.link || seen.has(h.link)) continue;
        seen.add(h.link);
        results.push(h);
      }
      if (results.length >= 60) break; // enough raw material
    }
    if (!results.length) return [];

    // 3) Extract structured company candidates with a real trigger + source URL.
    const system = 'You are a B2B lead researcher for Nivaria, a competitor-intelligence '
      + 'app for SaaS sales and product-marketing teams. From raw web-search results, extract '
      + 'companies that plausibly feel competitor / market-monitoring pain (crowded category, '
      + 'active /compare or /alternatives pages, a competitive role recently opened, fresh funding, '
      + 'or a founder describing manual competitor tracking). Never use em-dashes, en-dashes, or a '
      + 'connecting "+"; write "and" instead. Return JSON only.';
    const user = 'ICP brief:\n' + String(brief || '').slice(0, 2000)
      + '\n\nRegion hints: ' + (regionHints || 'none')
      + '\n\nToday is ' + new Date().toISOString().slice(0, 10) + '.'
      + '\n\nSearch results (JSON):\n' + JSON.stringify(results.slice(0, 60))
      + `\n\nReturn up to ${Math.min(targetCount * 2, 40)} candidates as JSON:`
      + '\n{ "candidates": [ { "company": string, "domain": string|null, "category": string, '
      + '"stage_size": string, "region": string, "trigger": string (the ONE specific reason now), '
      + '"trigger_url": string (MUST be one of the result links above), '
      + '"trigger_date": string|null (ISO YYYY-MM-DD when the trigger happened, inferred from the '
      + 'result; null if the result gives no date) } ] }'
      + '\nOnly include a candidate if you can point to a real trigger_url from the results. '
      + 'Prefer the freshest triggers (this week, this month) over older ones. '
      + 'Do not invent companies, URLs, or dates.';

    const parsed = await structuredCall({ system, user, maxTokens: 3000 });
    const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

    // 4) Keep only candidates whose trigger_url actually appeared in results.
    const validLinks = seen;
    const out = [];
    const byDomain = new Set();
    for (const c of list) {
      if (!c || !c.company || !c.trigger_url || !validLinks.has(c.trigger_url)) continue;
      const domain = (c.domain || domainFromUrl(c.trigger_url) || '').toLowerCase();
      const dedupeKey = domain || c.company.toLowerCase();
      if (byDomain.has(dedupeKey)) continue;
      byDomain.add(dedupeKey);
      out.push({
        company: c.company,
        domain: domain || null,
        category: c.category || null,
        stage_size: c.stage_size || null,
        region: c.region || null,
        trigger: c.trigger || null,
        trigger_url: c.trigger_url,
        trigger_date: normalizeTriggerDate(c.trigger_date),
      });
    }
    // Freshness first: surface the companies with the newest triggers before the
    // older ones, then cap. Undated triggers sort after dated ones. Ranking and
    // stale down-weighting happen again at persist/query time (see store.js).
    out.sort((a, b) => triggerRecencyRank(a.trigger_date) - triggerRecencyRank(b.trigger_date));
    return out.slice(0, targetCount);
  }

  // Model-expanded search queries, with a static fallback if the model is
  // unavailable so discovery still works without an Anthropic key.
  async buildQueries(brief, regionHints) {
    const region = regionHints ? ` ${regionHints}` : '';
    const fallback = [
      `SaaS "competitive intelligence" OR "product marketing" hiring${region}`,
      `"/compare" OR "/alternatives" page SaaS pricing${region}`,
      `SaaS startup raised seed funding crowded market${region}`,
      `founder "tracking competitors" spreadsheet manual${region}`,
    ];
    const system = 'Turn an ICP brief into 6 concise Google search queries that surface companies '
      + 'feeling competitor-monitoring pain. Return JSON only. No em-dashes, en-dashes, or connecting "+".';
    const user = 'Brief:\n' + String(brief || '').slice(0, 1500)
      + '\nRegion hints: ' + (regionHints || 'none')
      + '\n\nReturn: { "queries": [ up to 6 short query strings ] }';
    const parsed = await structuredCall({ system, user, maxTokens: 600 });
    const qs = Array.isArray(parsed?.queries) ? parsed.queries.filter(q => typeof q === 'string' && q.trim()) : [];
    return (qs.length ? qs : fallback).slice(0, 6);
  }

  // ── People ────────────────────────────────────────────────────────────────────
  async findPeople(company, roles) {
    this.ensureConfigured();
    const roleTerms = (roles && roles.length ? roles : ['Founder', 'Product Marketing']).slice(0, 4);
    const q = `"${company}" (${roleTerms.map(r => `"${r}"`).join(' OR ')}) site:linkedin.com/in`;
    const hits = await this.search(q, { num: 10 });
    if (!hits.length) return [];

    const system = 'From LinkedIn search results, identify the single best CURRENT contact at the '
      + 'named company for competitor-intelligence outreach, preferring the given roles. Only choose '
      + 'someone who still works at the company today: the result must show the role as current '
      + '(present tense, no end date, and the headline is not prefixed "Ex-", "former", "formerly", '
      + 'or "previously"), or a recent source must tie them to the company. If the only matches have '
      + 'left the company (headline says "Ex-Company", "former", or "previously"), return '
      + '{ "person": null }. Return JSON only. Never invent a person or a profile URL: use only what '
      + 'appears in the results.';
    const user = `Company: ${company}\nPreferred roles: ${roleTerms.join(', ')}\n\n`
      + 'Results (JSON):\n' + JSON.stringify(hits)
      + '\n\nReturn: { "person": { "person_name": string, "person_title": string (their CURRENT '
      + 'title at the company), "person_seniority": string, "profileUrl": string (must be one of the '
      + 'result links), "channel": "linkedin", "employment_verified": boolean (true only if the '
      + 'results show they currently work at the company), "employment_evidence": string (the exact '
      + 'phrase from the result that shows current employment) } } or { "person": null } if no '
      + 'current employee fits.';
    const parsed = await structuredCall({ system, user, maxTokens: 800 });
    const p = parsed?.person;
    if (!p || !p.profileUrl || !hits.some(h => h.link === p.profileUrl)) return [];
    // Rule 1: never surface a past employee. Require the model's present-tense
    // confirmation, and reject anyone whose own result still reads as a former
    // employee of THIS company (a backstop for model slips).
    if (p.employment_verified !== true) return [];
    const matched = hits.find(h => h.link === p.profileUrl);
    const evidence = `${p.person_title || ''} ${matched?.title || ''} ${matched?.snippet || ''}`;
    if (looksFormerAtCompany(evidence, company)) return [];
    return [{
      person_name: p.person_name || null,
      person_title: p.person_title || null,
      person_seniority: p.person_seniority || null,
      profileUrl: p.profileUrl,
      channel: p.channel || 'linkedin',
      employment_verified: true,
    }];
  }

  // ── Contact ────────────────────────────────────────────────────────────────────
  // Phase 1: no email finder. Always manual, with the profile URL preserved so it
  // can be grabbed via the Apollo/Hunter Chrome extension. Never fabricated.
  async findContact(person) {
    return {
      contact_status: 'manual',
      channel: person?.channel || 'linkedin',
      handle_or_email: person?.profileUrl || null,
      backup_channel: person?.profileUrl ? 'linkedin' : null,
      profileUrl: person?.profileUrl || null,
    };
  }
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when the text reads as a PAST employee of this specific company, e.g.
// "Ex-Acme", "formerly at Acme", "previously Acme", "left Acme". Tied to the
// company name within a short window so an unrelated "formerly at Google" on
// someone who now works at Acme does not trip it.
function looksFormerAtCompany(text, company) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const c = String(company || '').toLowerCase().trim();
  if (!c) return false;
  const cq = escapeRegex(c);
  return (
    new RegExp(`\\bex[-\\s]?${cq}\\b`).test(t) ||
    new RegExp(`\\b(former|formerly|previously)\\b[^.;|]{0,40}\\b${cq}\\b`).test(t) ||
    new RegExp(`\\b(left|no longer (?:at|with))\\b[^.;|]{0,20}\\b${cq}\\b`).test(t)
  );
}

// Normalize a model-supplied trigger date to an ISO YYYY-MM-DD string, or null.
// Rejects unparseable, future (beyond today), or absurdly old (>10 years) values
// so a hallucinated date cannot masquerade as fresh intel.
function normalizeTriggerDate(v) {
  if (!v) return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  const now = Date.now();
  if (t > now + 86400000) return null;                 // future
  if (t < now - 10 * 365 * 86400000) return null;      // older than ~10 years
  return new Date(t).toISOString().slice(0, 10);
}

// Sort key for freshness-first ordering: newer dates rank lower (come first),
// undated triggers rank last.
function triggerRecencyRank(dateStr) {
  const t = Date.parse(dateStr || '');
  return Number.isFinite(t) ? -t : Infinity;
}

// Very light region -> Serper country-code hint.
function regionHintToGl(hint) {
  const h = String(hint || '').toLowerCase();
  if (/\b(us|usa|united states|north america)\b/.test(h)) return 'us';
  if (/\b(uk|united kingdom|britain|england)\b/.test(h)) return 'gb';
  if (/\b(canada)\b/.test(h)) return 'ca';
  if (/\b(australia)\b/.test(h)) return 'au';
  if (/\b(germany|dach)\b/.test(h)) return 'de';
  return undefined;
}

// Default Phase-1 provider. Swap this factory for an enrichment provider in
// Phase 2; the pipeline only depends on the interface.
function getProvider() {
  return new SearchFirstProvider();
}

module.exports = { SearchFirstProvider, getProvider, OutboundConfigError, rolesForStage };
