// Taste Gap view: the run form, the live trace, the brief (battlecard styling),
// the demographics chart, the geo-gap map and the Runs history.
//
// Routes (app.js): #/taste is the form, #/taste/:id one run, #/runs the
// history. A running run streams its trace from /api/taste/runs/:id/events
// (server-sent events; each step arrives when it starts and again when it
// finishes, under the same n). When the stream ends the run is fetched again
// and the brief replaces the trace.
//
// Scores from the API are on a 0 to 1 scale (demographics -1 to 1); the view
// shows whole points out of 100, as the brief's prose does.
//
// Color: our brand is series 1 (blue) and the rival series 2 (orange) in the
// chart; the map's diverging scale runs blue (we lead) through gray to red
// (rival leads). The steps come from the dataviz reference palette and were
// validated for both themes; orange sits under 3:1 on the light surface, so
// the chart always offers its table view and values on hover.

const Taste = (() => {
  let source = null;     // EventSource for the live run
  let map = null;        // Leaflet map
  let liveId = null;     // run id the open stream belongs to
  let steps = [];        // live trace, indexed by n - 1
  let current = null;    // run on screen
  let geoRival = null;   // rival entity_id the map shows
  let viewCached = false; // the run on screen was served from the brief cache
  let featuredPairs = []; // /api/taste/featured, for the chips
  let readOnly = false;  // the public page behind a share link (Taste.renderShared)

  const pts = x => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) : null);
  const signed = n => (n == null ? 'n/a' : (n > 0 ? '+' : '') + n);
  const secs = ms => (ms == null ? '' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's');
  const num = n => (n == null ? 'n/a' : String(n));
  const capFirst = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

  const DOMAIN_LABEL = { artist: 'Music', movie: 'Film', tv_show: 'TV', place: 'Places', brand: 'Other brands' };
  const AGE_LABEL = {
    '24_and_younger': '24 and under', '25_to_29': '25 to 29', '30_to_34': '30 to 34',
    '35_to_44': '35 to 44', '45_to_54': '45 to 54', '55_and_older': '55 and over',
    female: 'Female', male: 'Male',
  };

  const ICON = {
    spin: '<span class="taste-spin" aria-hidden="true"></span>',
    ok: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    err: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    swap: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    note: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  };

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  function stopStream() {
    if (source) { source.close(); source = null; }
    liveId = null;
  }

  function cleanup() {
    stopStream();
    if (map) { map.remove(); map = null; }
  }

  // Leaving the run page closes its stream and map.
  window.addEventListener('hashchange', () => {
    const h = window.location.hash;
    if (!(liveId && h === '#/taste/' + liveId)) cleanup();
  });

  const root = () => document.getElementById('page-root');

  function brandLine(run) {
    // A run with no rival named finds them (rival discovery).
    if (!run.rivals.length) return esc(run.brand) + ' vs the rivals the agent finds';
    return esc(run.brand) + ' vs ' + run.rivals.map(esc).join(' and ');
  }

  function statusBadge(status) {
    if (status === 'done') return '<span class="badge badge-low">Done</span>';
    if (status === 'error') return '<span class="badge badge-high">Failed</span>';
    return '<span class="badge badge-accent">Running</span>';
  }

  // ── Form ────────────────────────────────────────────────────────────────────

  async function renderForm() {
    let status = { ready: true };
    let recent = [];
    try {
      [status, { runs: recent }] = await Promise.all([API.get('/taste/status'), API.get('/taste/runs'), loadFeatured()]);
    } catch (e) {
      toast(friendlyMessage(e), 'error');
    }
    const running = recent.find(r => r.status === 'running');

    root().innerHTML = `
      <div class="bc-wrap taste-wrap">
        <div class="bc-section bc-summary">
          <div class="bc-section-label">How it works</div>
          <div class="bc-section-body">
            Name your brand and one or two rivals. An agent pulls Qloo taste data on both audiences
            (music, film, TV, other brands and, with a city, places and the map) and writes a brief:
            where the rival's audience is that yours is not, and which segments to win first.
            Every number in the brief comes from Qloo.
          </div>
        </div>

        ${featuredSection(featuredPairs)}

        ${status.ready ? '' : `
          <div class="bc-section taste-notice">
            <div class="bc-section-body">New briefs cannot be written on this server right now. The featured briefs above open instantly.</div>
          </div>`}

        ${running ? `
          <div class="bc-section taste-notice">
            <div class="bc-section-body">
              A run is going: <strong>${brandLine(running)}</strong>.
              <a href="#/taste/${running.id}">Watch it</a>
            </div>
          </div>` : ''}

        <div id="taste-form-notice"></div>

        <form class="bc-section taste-form" id="taste-form" novalidate>
          <div class="bc-section-label">New brief</div>
          <div class="taste-form-grid">
            <div class="form-group">
              <label class="form-label" for="taste-brand">Your brand</label>
              <input class="form-input" id="taste-brand" name="brand" maxlength="80" autocomplete="off" placeholder="Glossier" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="taste-rival">Rival <span class="taste-optional">optional</span></label>
              <input class="form-input" id="taste-rival" name="rival" maxlength="80" autocomplete="off" placeholder="Fenty Beauty" aria-describedby="taste-rival-hint">
              <p class="taste-field-hint" id="taste-rival-hint">Leave blank and the agent will find your closest rivals.</p>
            </div>
            <div class="form-group">
              <label class="form-label" for="taste-rival2">Second rival <span class="taste-optional">optional</span></label>
              <input class="form-input" id="taste-rival2" name="rival2" maxlength="80" autocomplete="off" placeholder="Rare Beauty">
            </div>
            <div class="form-group">
              <label class="form-label" for="taste-city">City <span class="taste-optional">optional, adds places and the map</span></label>
              <input class="form-input" id="taste-city" name="city" maxlength="80" autocomplete="off" placeholder="New York">
            </div>
          </div>
          <div class="taste-form-foot">
            <span class="taste-hint">Only these names are sent to the model. A pair briefed in the last two weeks opens instantly; a new one takes up to three minutes.</span>
            <button class="btn btn-primary" type="submit" id="taste-submit" ${status.ready ? '' : 'disabled'}>Run the brief</button>
          </div>
        </form>

        ${recent.length ? `
          <div class="bc-section">
            <div class="bc-section-header">
              <div class="bc-section-label">Recent runs</div>
              <a href="#/runs" class="btn btn-ghost btn-sm">All runs</a>
            </div>
            <ul class="talking-points">
              ${recent.slice(0, 3).map(r => `
                <li class="talking-point taste-recent">
                  <a href="#/taste/${r.id}" class="taste-recent-link">
                    <span class="taste-recent-title">${brandLine(r)}${r.city ? ' in ' + esc(r.city) : ''}</span>
                    <span class="taste-recent-sub">${esc(r.headline || r.error_message || 'Running')}</span>
                  </a>
                  ${statusBadge(r.status)}
                </li>`).join('')}
            </ul>
          </div>` : ''}
      </div>`;

    document.getElementById('taste-form').addEventListener('submit', submit);
    for (const id of ['taste-brand', 'taste-rival', 'taste-rival2']) attachSuggest(document.getElementById(id));
    // Ready to type, without scrolling the banner and featured briefs out of
    // view, and without opening a phone's keyboard.
    if (window.matchMedia('(pointer: fine)').matches) {
      document.getElementById('taste-brand').focus({ preventScroll: true });
    }
  }

  // ── Brand autocomplete ──────────────────────────────────────────────────────
  // Suggestions from Qloo's brand search (/api/taste/search) under each brand
  // input, as an ARIA combobox: arrows move, Enter picks, Escape closes. One
  // request per pause in typing, answers cached per query, and a late answer
  // for an older query is dropped.

  const suggestCache = new Map();

  async function suggestionsFor(q) {
    const key = q.toLowerCase();
    if (!suggestCache.has(key)) {
      const { results } = await API.get('/taste/search?q=' + encodeURIComponent(q));
      suggestCache.set(key, results || []);
    }
    return suggestCache.get(key);
  }

  function attachSuggest(input) {
    const wrap = input.parentElement;
    wrap.classList.add('taste-suggest-wrap');
    const list = document.createElement('ul');
    list.className = 'taste-suggest';
    list.id = input.id + '-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.appendChild(list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);

    let items = [];
    let active = -1;
    let timer = null;
    let seq = 0;

    const close = () => {
      list.hidden = true;
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
    const paint = () => {
      if (!items.length) { close(); return; }
      list.innerHTML = items.map((r, i) => `
        <li role="option" id="${list.id}-${i}" data-i="${i}" aria-selected="${i === active}"
            class="taste-suggest-item${i === active ? ' active' : ''}">
          <span class="taste-suggest-name">${esc(r.name)}</span>
          ${r.description ? `<span class="taste-suggest-desc">${esc(r.description)}</span>` : ''}
        </li>`).join('');
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', list.id + '-' + active);
      else input.removeAttribute('aria-activedescendant');
    };
    const choose = i => {
      input.value = items[i].name;
      items = [];
      close();
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { items = []; close(); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const results = await suggestionsFor(q);
          if (mine !== seq || input.value.trim() !== q) return;
          items = results;
          active = -1;
          if (document.activeElement === input) paint();
        } catch (_) { /* suggestions are optional */ }
      }, 250);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        const n = items.length;
        active = list.hidden ? (e.key === 'ArrowDown' ? 0 : n - 1) : (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        paint();
      } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
        e.preventDefault();
        choose(active);
      } else if (e.key === 'Escape' && !list.hidden) {
        e.preventDefault();
        close();
      }
    });
    // mousedown, not click, so the pick lands before the input loses focus.
    list.addEventListener('mousedown', e => {
      const li = e.target.closest('[data-i]');
      if (!li) return;
      e.preventDefault();
      choose(Number(li.dataset.i));
    });
    input.addEventListener('blur', () => setTimeout(close, 100));
  }

  // ── Featured briefs ─────────────────────────────────────────────────────────
  // Ten popular rival pairs, written ahead of time and served from the
  // database. A chip opens the cached brief, so it costs nothing and always
  // loads; every refusal and failure points at them.

  async function loadFeatured() {
    try {
      ({ pairs: featuredPairs } = await API.get('/taste/featured'));
    } catch (_) {
      featuredPairs = [];
    }
    return featuredPairs;
  }

  function pairLine(p) {
    return esc(p.brand) + ' vs ' + p.rivals.map(esc).join(' and ');
  }

  function featuredChips(pairs = featuredPairs) {
    const ready = pairs.filter(p => p.run);
    if (!ready.length) return '';
    return `<div class="taste-chips">${ready.map(p => `
      <a class="taste-chip" href="#/taste/${p.run.id}?cached=1">${pairLine(p)}${p.city ? '<span class="taste-chip-city"> · ' + esc(p.city) + '</span>' : ''}</a>`).join('')}</div>`;
  }

  function featuredSection(pairs) {
    const ready = pairs.filter(p => p.run);
    if (!ready.length) return '';
    const top = ready.find(p => p.featured) || ready[0];
    const r = top.run;
    const facts = [
      r.segments ? r.segments + ' rival-owned segment' + (r.segments === 1 ? '' : 's') : '',
      r.hotspots ? r.hotspots + ' map hotspot' + (r.hotspots === 1 ? '' : 's') : '',
    ].filter(Boolean).join(', ');
    return `
      <div class="taste-section-title">Featured briefs</div>
      <div class="bc-section taste-featured">
        <div class="taste-hint">Popular rival pairs, already written. They open instantly.</div>
        ${featuredChips(pairs)}
      </div>
      <div class="bc-section bc-response taste-example taste-example--featured">
        <div class="bc-section-header">
          <div class="bc-section-label">Featured brief</div>
          <span class="taste-hint">${esc(facts)}</span>
        </div>
        <div class="taste-example-title">${pairLine(top)}${top.city ? ' in ' + esc(top.city) : ''}</div>
        <h2 class="bc-headline taste-example-headline">${esc(r.headline)}</h2>
        <div class="bc-section-body">${esc(r.summary)}</div>
        ${r.win_first.length ? `
          <ol class="taste-example-wins">
            ${r.win_first.map(w => `
              <li><span class="taste-rank">${esc(String(w.rank))}</span>
                <span><strong>${esc(w.segment)}</strong>. ${esc(w.campaign_hook)}</span></li>`).join('')}
          </ol>` : ''}
        <div class="taste-example-actions">
          <a class="btn btn-primary btn-sm" href="#/taste/${r.id}?cached=1">Open the full brief</a>
        </div>
      </div>`;
  }

  // A friendly notice that points at the featured briefs: a refused run (one
  // at a time, the daily limit) or a failed one. Never a raw error.
  function notice(message, { error = false, label = '' } = {}) {
    const chips = featuredChips();
    return `
      <div class="bc-section taste-notice ${error ? 'taste-notice--error' : ''}" role="status">
        ${label ? '<div class="bc-section-label">' + esc(label) + '</div>' : ''}
        <div class="bc-section-body">${esc(message)}</div>
        ${chips ? '<div class="taste-hint taste-notice-hint">Featured briefs, ready now:</div>' + chips : ''}
      </div>`;
  }

  // The server's refusals carry a friendly message and a code; anything else
  // (a crash page, a dropped connection) gets a plain one.
  function friendlyMessage(err) {
    const msg = String(err?.message || '');
    if (err?.code || (msg && !/^HTTP \d+|fetch|network|JSON/i.test(msg))) return msg;
    return 'Something went wrong on our side. The featured briefs open instantly, or try again in a minute.';
  }

  function showNotice(boxId, message) {
    const box = document.getElementById(boxId);
    if (!box) { toast(message, 'error'); return; }
    box.innerHTML = notice(message);
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function submit(e) {
    e.preventDefault();
    const f = e.target;
    const brand = f.brand.value.trim();
    const rivals = [f.rival.value.trim(), f.rival2.value.trim()].filter(Boolean);
    if (!brand) { toast('Enter your brand.', 'error'); return; }
    const btn = document.getElementById('taste-submit');
    btn.disabled = true;
    btn.textContent = 'Starting...';
    document.getElementById('taste-form-notice').innerHTML = '';
    try {
      const res = await API.post('/taste/runs', { brand, rivals, city: f.city.value.trim() });
      navigate('#/taste/' + res.run.id + (res.cached ? '?cached=1' : ''));
    } catch (err) {
      if (err.code === 'busy' && err.id) { navigate('#/taste/' + err.id); return; }
      showNotice('taste-form-notice', friendlyMessage(err));
      btn.disabled = false;
      btn.textContent = 'Run the brief';
    }
  }

  // ── Run page ────────────────────────────────────────────────────────────────

  // cached: opened from the brief cache or a featured chip.
  async function renderRun(id, { cached = false } = {}) {
    let run;
    try {
      ({ run } = await API.get('/taste/runs/' + encodeURIComponent(id)));
    } catch (e) {
      root().innerHTML = `<div class="empty-state">
        <div class="empty-title">Brief not found</div>
        <div class="empty-desc">It may have been removed. The featured briefs on the Dashboard open instantly.</div>
        <a class="btn btn-primary" href="#/taste">Dashboard</a>
      </div>`;
      return;
    }
    current = run;
    geoRival = null;
    viewCached = run.status === 'done' && (cached || Boolean(run.example_key));
    if (run.status === 'error') await loadFeatured();
    paintRun(run);
    if (run.status === 'running') openStream(run.id, run.steps || []);
  }

  function header(run) {
    const label = readOnly ? 'Shared brief' : run.status === 'done' ? 'Brief ready' : run.status === 'error' ? 'Run failed' : 'Running';
    const cls = run.status === 'done' ? 'taste-state--done' : run.status === 'error' ? 'taste-state--error' : 'taste-state--running';
    // Our brand and each rival, with Qloo's image when there is one and a
    // neutral initial otherwise (also when an image fails to load).
    const marks = [
      run.brief?.brand || { name: run.brand },
      ...(run.brief?.rivals?.length ? run.brief.rivals : run.rivals.map(name => ({ name }))),
    ];
    return `
      <div class="bc-header">
        <div class="bc-left">
          <div class="taste-marks">${marks.map(brandMark).join('')}</div>
          <div>
            <div class="bc-comp-name">${brandLine(run)}</div>
            <div class="taste-sub">
              ${run.example_key
                ? '<span class="badge badge-accent">Example</span> · ' + (run.city ? esc(run.city) : 'No city, so no places or map')
                : (run.city ? 'In ' + esc(run.city) : 'No city, so no places or map')}
            </div>
          </div>
        </div>
        <div class="bc-threat ${cls}">
          <div class="bc-threat-label">${label}</div>
          <div class="bc-threat-date">${formatDate(run.created_at)}</div>
        </div>
      </div>`;
  }

  function brandMark(b) {
    const initial = esc((String(b.name || '?').trim()[0] || '?').toUpperCase());
    const ph = `<span class="taste-mark taste-mark--ph" title="${esc(b.name)}">${initial}</span>`;
    if (!b.image) return ph;
    return `<span class="taste-mark" title="${esc(b.name)}"><img src="${esc(b.image)}" alt="${esc(b.name)}" width="44" height="44"
      referrerpolicy="no-referrer" onerror="Taste.markFallback(this)" data-initial="${initial}"></span>`;
  }

  function markFallback(img) {
    const span = img.parentElement;
    span.classList.add('taste-mark--ph');
    span.textContent = img.dataset.initial || '?';
  }

  function paintRun(run) {
    cleanupMapOnly();
    let body;
    if (run.status === 'running') {
      body = `
        <div class="bc-section">
          <div class="bc-section-header">
            <div class="bc-section-label">Live trace</div>
            <span class="taste-hint" id="taste-elapsed"></span>
          </div>
          <ol class="taste-trace" id="taste-trace">${traceItems(run.steps || [])}</ol>
        </div>`;
    } else if (run.status === 'error') {
      body = `
        ${notice(run.error_message || 'This brief could not be written. The featured briefs open instantly, or try again later.', { error: true, label: 'What went wrong' })}
        <div id="taste-run-notice"></div>
        ${traceSection(run, false)}
        ${footer(run)}`;
    } else {
      body = (viewCached ? cachedBanner(run) : '<div id="taste-run-notice"></div>') + results(run) + footer(run);
    }
    root().innerHTML = `<div class="bc-wrap taste-wrap">${header(run)}${body}</div>`;
    if (run.status === 'done') afterResults(run);
  }

  function dayOf(d) {
    const t = parseDbDate(d);
    return t ? t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }

  // A brief served from the cache: when it was written, and a fresh run on
  // request (which counts against the visitor's daily runs).
  function cachedBanner(run) {
    return `
      <div class="bc-section taste-cached">
        <div class="taste-cached-text">
          <strong>Cached brief from ${esc(dayOf(run.finished_at))}</strong>
          <span class="taste-hint">Opened instantly, with no new Qloo or model calls.</span>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" onclick="Taste.rerun(${run.id})">Run fresh</button>
      </div>
      <div id="taste-run-notice"></div>`;
  }

  function cleanupMapOnly() {
    if (map) { map.remove(); map = null; }
  }

  // ── Live trace ──────────────────────────────────────────────────────────────

  function traceItem(s, switchIndex = 0) {
    const icon = s.kind === 'switch' || s.kind === 'replan' ? ICON.swap : s.kind === 'note' ? ICON.note
      : s.status === 'running' ? ICON.spin : s.status === 'error' ? ICON.err : ICON.ok;
    const cls = 'taste-step taste-step--' + (s.kind === 'tool' ? s.status : s.kind)
      + (['discover_rivals', 'choose_rivals', 'follow_lead'].includes(s.tool) ? ' taste-step--decision' : '');
    // The model's own narration between calls reads as a quote.
    const label = s.kind === 'note' ? '"' + s.label + '"' : s.kind === 'switch' ? switchLabel(s, switchIndex) : s.label;
    return `
      <li class="${cls}">
        <span class="taste-step-icon">${icon}</span>
        <span class="taste-step-main">
          <span class="taste-step-label">${esc(label)}</span>
          ${stepSummary(s) ? `<span class="taste-step-sum">${esc(stepSummary(s))}</span>` : ''}
        </span>
        <span class="taste-step-time">${s.status === 'running' ? '' : secs(s.ms)}</span>
      </li>`;
  }

  // Raw provider and tool errors stay off the page: a failed step says so
  // plainly, and a model switch shows only its label.
  function stepSummary(s) {
    if (s.kind === 'note' || s.kind === 'switch' || s.kind === 'replan') return '';
    if (s.status === 'error') return 'This step did not work, so the agent carried on without it.';
    return s.summary || '';
  }

  // The agent's plan, pinned at the top of the trace. Each step ticks off as
  // the tools it named finish; while the run goes, the first open step spins.
  // A revised plan says why it changed.
  function planBlock(p) {
    const items = p.items || [];
    const active = p.status === 'running' ? items.findIndex(it => it.status === 'pending') : -1;
    return `
      <li class="taste-plan">
        <div class="taste-plan-head">
          <span class="taste-plan-label">The agent's plan</span>
          ${p.revisions ? `<span class="taste-hint">Revised${p.revisions > 1 ? ' ' + p.revisions + ' times' : ''}</span>` : ''}
        </div>
        <ol class="taste-plan-steps">
          ${items.map((it, i) => {
            const state = i === active ? 'active' : it.status;
            const mark = it.status === 'done' ? ICON.ok : i === active ? ICON.spin : String(i + 1);
            return `
              <li class="taste-plan-step taste-plan-step--${esc(state)}">
                <span class="taste-plan-mark">${mark}</span>
                <span class="taste-plan-text">${esc(it.text)}${it.status === 'skipped' ? ' <span class="taste-hint">(skipped)</span>' : ''}</span>
              </li>`;
          }).join('')}
        </ol>
        ${p.reason ? `<div class="taste-plan-why">Why the plan changed: ${esc(p.reason)}</div>` : ''}
      </li>`;
  }

  function traceItems(list) {
    const shown = list.filter(Boolean);
    if (!shown.length) return '<li class="taste-step taste-step--running"><span class="taste-step-icon">' + ICON.spin + '</span><span class="taste-step-main"><span class="taste-step-label">Starting the agent</span></span></li>';
    const plan = shown.find(s => s.kind === 'plan');
    let switches = 0;
    return (plan ? planBlock(plan) : '') + shown.filter(s => s.kind !== 'plan').map(s => traceItem(s, s.kind === 'switch' ? switches++ : 0)).join('');
  }

  // A model switch in plain words, built from the step itself so stored runs
  // read the same: "Primary model busy, switched to Gemini (gemini-3.5-flash)".
  // A model that cannot run at all (a bad key, a missing model) is unavailable
  // rather than busy. Status codes stay out of the page.
  function switchLabel(s, index) {
    const unavailable = s.reason ? s.reason === 'unavailable' : /((?:401|402|403|404))|auth error|no credit|not available/i.test((s.label || '') + ' ' + (s.summary || ''));
    const key = String(s.to || '');
    const cut = key.indexOf(':');
    const name = cut < 0 ? key : (PROVIDER_LABEL[key.slice(0, cut)] || capFirst(key.slice(0, cut))) + ' (' + key.slice(cut + 1) + ')';
    return (index === 0 ? 'Primary model' : 'Fallback model') + (unavailable ? ' unavailable' : ' busy') + ', switched to ' + name;
  }

  // As src/taste/llm.js labels its providers.
  const PROVIDER_LABEL = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter', zai: 'Z.ai', anthropic: 'Claude', baseten: 'Baseten', cerebras: 'Cerebras', github: 'GitHub Models', scripted: 'Scripted stand-in' };

  // The model that wrote the brief: from the brief's provenance, else (older
  // runs) the last model the run used.
  function writerOf(run) {
    const w = run.brief?.provenance?.written_by;
    if (w) return w.label + ' · ' + w.model;
    const last = (run.providers || [])[(run.providers || []).length - 1];
    return last ? (PROVIDER_LABEL[last.provider] || capFirst(last.provider)) + ' · ' + last.model : '';
  }

  function traceSection(run, open) {
    const list = (run.steps || []).filter(Boolean);
    if (!list.length) return '';
    const tools = list.filter(s => s.kind === 'tool' && s.tool !== 'submit_brief').length;
    const p = run.brief?.provenance;
    const facts = [
      tools + ' tool call' + (tools === 1 ? '' : 's'),
      p?.qloo_calls ? p.qloo_calls + ' Qloo requests' : '',
      run.turns ? run.turns + ' model turn' + (run.turns === 1 ? '' : 's') : '',
      run.duration_ms ? secs(run.duration_ms) : '',
    ].filter(Boolean).join(', ');
    const writer = writerOf(run);
    return `
      <details class="bc-section taste-trace-wrap" id="taste-trace-section" ${open ? 'open' : ''}>
        <summary class="taste-trace-head">
          <span class="bc-section-label">How the agent built this brief</span>
          <span class="taste-hint">${esc(facts)}${writer ? ' · written by ' + esc(writer) : ''}</span>
        </summary>
        <ol class="taste-trace">${traceItems(list)}</ol>
      </details>`;
  }

  // ── Provenance ──────────────────────────────────────────────────────────────
  // Every score in a brief is attached by the server from this run's Qloo
  // results, never written by the model, and a citation that cannot be found
  // there is dropped. The note says so, with the counts, and the row under it
  // names the Qloo endpoints that fed the brief.

  // Older briefs carry no provenance: count their cited items here.
  function countDataPoints(b) {
    const keys = new Set();
    const add = e => keys.add(e.kind === 'cell' ? 'c' + e.geohash : 'e' + e.entity_id);
    for (const x of [...(b.rival_owned_segments || []), ...(b.win_first || [])]) (x.evidence || []).forEach(add);
    for (const h of b.geo_hotspots || []) add({ ...h, kind: 'cell' });
    return keys.size;
  }

  function proofBlock(run) {
    const b = run.brief;
    const p = b.provenance || {};
    const points = p.data_points ?? countDataPoints(b);
    const dropped = typeof p.dropped === 'number' ? p.dropped : null;
    const count = points + ' Qloo data point' + (points === 1 ? '' : 's') + (dropped == null ? '' : ', ' + dropped + ' dropped');
    const endpoints = p.endpoints || [];
    const writer = readOnly ? (p.written_by ? p.written_by.label + ' · ' + p.written_by.model : '') : writerOf(run);
    return `
      <div class="bc-section taste-proof">
        <details class="taste-proof-note">
          <summary>
            <span class="taste-proof-check">${ICON.ok}</span>
            <span class="taste-proof-claim">Every number in this brief comes from Qloo. <span class="taste-proof-how">How we check</span></span>
            <span class="taste-proof-count">${esc(count)}</span>
          </summary>
          <ol class="taste-proof-steps">
            <li>The agent never writes a score. It cites the Qloo entities and map cells it used, by reference.</li>
            <li>The server looks each citation up in this run's Qloo results and attaches Qloo's actual numbers.</li>
            <li>A citation it cannot find there is removed before the brief is saved${dropped == null ? '' : dropped === 0 ? ': none this time' : ': ' + dropped + ' this time'}.</li>
          </ol>
        </details>
        ${endpoints.length || writer ? `
          <div class="taste-endpoints">
            ${endpoints.length ? `<span class="taste-endpoints-label">Qloo endpoints used</span>
              ${endpoints.map(e => `<span class="taste-endpoint" title="${esc(e.path)}">${esc(e.label)} <span class="taste-endpoint-n">${esc(String(e.calls))}</span></span>`).join('')}` : ''}
            ${writer ? `<span class="taste-writer">Written by ${esc(writer)}${readOnly ? '' : ' · <a href="#taste-trace-section" onclick="Taste.openTrace(event)">Agent trace</a>'}</span>` : ''}
          </div>` : ''}
      </div>`;
  }

  function openTrace(e) {
    e.preventDefault();
    const t = document.getElementById('taste-trace-section');
    if (!t) return;
    t.open = true;
    t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openStream(id, initial) {
    stopStream();
    liveId = id;
    steps = [];
    for (const s of initial) steps[s.n - 1] = s;
    const started = parseDbDate(current.created_at)?.getTime() || Date.now();
    const tick = setInterval(() => {
      const elapsed = document.getElementById('taste-elapsed');
      if (!elapsed || liveId !== id) { clearInterval(tick); return; }
      elapsed.textContent = Math.max(0, Math.round((Date.now() - started) / 1000)) + 's';
    }, 1000);

    source = new EventSource('/api/taste/runs/' + id + '/events');
    source.addEventListener('step', e => {
      const s = JSON.parse(e.data);
      steps[s.n - 1] = s;
      const list = document.getElementById('taste-trace');
      if (list) list.innerHTML = traceItems(steps);
    });
    source.addEventListener('end', async () => {
      clearInterval(tick);
      stopStream();
      if (window.location.hash !== '#/taste/' + id) return;
      try {
        const { run } = await API.get('/taste/runs/' + id);
        current = run;
        viewCached = false;
        if (run.status === 'error') await loadFeatured();
        paintRun(run);
        if (run.status === 'done') toast('Brief ready', 'success');
      } catch (err) { toast(friendlyMessage(err), 'error'); }
    });
    // EventSource reconnects on its own after a dropped connection; the
    // server replays the trace so far, so nothing is lost.
  }

  // ── Results ─────────────────────────────────────────────────────────────────

  function rivalName(brief, id) {
    return (brief.rivals.find(r => r.entity_id === id) || {}).name || 'Rival';
  }

  function evidenceRows(list) {
    if (!list.length) return '';
    return `
      <table class="taste-ev">
        <thead><tr><th scope="col">Evidence</th><th scope="col">Rival</th><th scope="col">You</th><th scope="col">Gap</th></tr></thead>
        <tbody>
          ${list.map(e => `
            <tr>
              <td>${esc(e.kind === 'cell' ? (e.label || e.neighborhood || e.area || 'Map cell') : e.name)}</td>
              <td>${num(pts(e.rival_affinity))}</td>
              <td>${num(pts(e.our_affinity))}</td>
              <td class="taste-gap">${signed(pts(e.gap))}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  const andList = items => (items.length < 3 ? items.join(' and ') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);

  // Under the pick built on follow_lead: the entity the agent followed, with
  // its gap, and what that entity's fans also over-index on, all as Qloo
  // returned them.
  function leadNote(b, l) {
    const found = (l.found || []).map(f => esc(f.name) + ' (' + num(pts(f.affinity)) + ')');
    return `
      <div class="taste-lead">
        <span class="taste-lead-label">Lead followed</span>
        <span>${esc(l.name)}: ${esc(rivalName(b, l.rival_id))} fans ${num(pts(l.rival_affinity))}, ${esc(b.brand?.name || 'yours')} fans ${num(pts(l.our_affinity))}.
          ${found.length ? `Its fans also over-index on ${andList(found)}.` : ''}
          <span class="taste-hint">Qloo affinity, 0 to 100.</span></span>
      </div>`;
  }

  function confidenceBadge(c) {
    const label = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }[c] || '';
    return label ? `<span class="badge ${c === 'high' ? 'badge-accent' : 'badge-neutral'}">${label}</span>` : '';
  }

  // Rival discovery: the brands the agent considered, the ones it picked and
  // why, all from discover_rivals and choose_rivals.
  function rivalChoiceCard(b) {
    const rc = b.rival_choice;
    if (!rc || !(rc.candidates || []).length) return '';
    const picked = rc.candidates.filter(c => c.picked);
    return `
      <div class="bc-section taste-choice">
        <div class="bc-section-header">
          <div class="bc-section-label">Rivals chosen by the agent</div>
          <span class="taste-hint">${esc(String(rc.candidates.length))} brands from Qloo insights on ${esc(b.brand?.name || '')} fans${rc.category ? ', including a pass filtered to ' + esc(rc.category) : ''}, ranked by shared category tags</span>
        </div>
        <div class="taste-choice-picked">
          ${picked.map(c => `<span class="taste-choice-pick">${brandMark(c)}<span>${esc(c.name)}</span></span>`).join('')}
        </div>
        <p class="taste-choice-reason">${esc(rc.reason)}</p>
        <div class="taste-choice-scroll">
          <table class="taste-ev taste-choice-table">
            <thead><tr><th scope="col">Brand Qloo found</th><th scope="col">Affinity</th><th scope="col">Shared category tags</th><th scope="col">Decision</th></tr></thead>
            <tbody>
              ${rc.candidates.map(c => `
                <tr class="${c.picked ? 'is-picked' : ''}">
                  <td>${esc(c.name)}</td>
                  <td>${num(c.affinity)}</td>
                  <td>${c.shared_tags.length ? c.shared_tags.map(esc).join(', ') : '<span class="taste-hint">None</span>'}</td>
                  <td>${c.picked ? '<span class="badge badge-accent">Chosen</span>'
                    : c.flags.length ? '<span class="taste-hint">Skipped: ' + esc(c.flags.join(', ')) + '</span>' : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function results(run) {
    const b = run.brief;
    const hasGeo = run.data && Object.keys(run.data.geo || {}).length > 0;
    const hasDemo = run.data && Object.keys(run.data.demographics || {}).length > 0;
    return `
      ${rivalChoiceCard(b)}
      <div class="bc-headline-wrap">
        <h2 class="bc-headline">${esc(b.headline)}</h2>
        ${readOnly ? '' : `<div class="bc-headline-actions">
          <button class="btn btn-secondary btn-sm" type="button" onclick="Taste.share(${run.id})">Share</button>
          <button class="btn btn-secondary btn-sm" type="button" id="taste-send-btn" onclick="Taste.send(${run.id})">Send to Slack or Discord</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="Taste.copy()">Copy brief</button>
          ${viewCached ? '' : `<button class="btn btn-ghost btn-sm" type="button" onclick="Taste.rerun(${run.id})">Run again</button>`}
        </div>`}
      </div>
      ${readOnly ? '' : '<div id="taste-share-panel"></div>'}
      ${proofBlock(run)}

      <div class="bc-section bc-summary">
        <div class="bc-section-label">Executive summary</div>
        <div class="bc-section-body">${esc(b.summary)}</div>
      </div>

      <div class="bc-section bc-response">
        <div class="bc-section-label">Win these first</div>
        <ol class="talking-points">
          ${b.win_first.map(w => `
            <li class="talking-point taste-win">
              <span class="taste-rank">${esc(String(w.rank))}</span>
              <div class="taste-win-body">
                <div class="taste-win-title">${esc(w.segment)}</div>
                <div>${esc(w.why)}</div>
                <div class="taste-win-hook"><strong>Campaign hook:</strong> ${esc(w.campaign_hook)}</div>
                ${w.lead ? leadNote(b, w.lead) : ''}
                ${(w.channels || []).length ? `<div class="bc-pattern-tags">${w.channels.map(c => `<span class="pattern-tag taste-channel">${esc(capFirst(c))}</span>`).join('')}</div>` : ''}
              </div>
            </li>`).join('')}
        </ol>
      </div>

      ${readOnly ? '' : traceSection(run, true)}

      <div class="taste-section-title">Taste segments the rival owns</div>
      <div class="bc-grid">
        ${b.rival_owned_segments.map(s => `
          <div class="bc-section taste-seg">
            <div class="bc-section-label">${esc(rivalName(b, s.rival_id))} owns · ${esc(DOMAIN_LABEL[s.domain] || s.domain)}</div>
            <div class="taste-seg-title">${esc(s.segment)}</div>
            <div class="bc-section-body">${esc(s.insight)}</div>
            ${evidenceRows(s.evidence)}
            <div class="taste-seg-foot">${confidenceBadge(s.confidence)}</div>
          </div>`).join('')}
      </div>

      ${hasGeo ? `
        <div class="bc-section bc-full taste-viz">
          <div class="bc-section-header">
            <div class="bc-section-label">Where on the map</div>
            <div id="taste-geo-tabs" class="taste-tabs"></div>
          </div>
          <div class="taste-geo">
            <div class="taste-map" id="taste-map" role="img" aria-label="Map of where each audience leads"></div>
            <div class="taste-geo-side" id="taste-geo-side"></div>
          </div>
        </div>` : ''}

      ${hasDemo ? `
        <div class="bc-section bc-full taste-viz">
          <div class="bc-section-label">Who the audiences are</div>
          <div id="taste-demo"></div>
        </div>` : ''}

      ${b.positioning.length ? `
        <div class="bc-section">
          <div class="bc-section-label">Positioning</div>
          ${b.positioning.map(p => `
            <div class="taste-pos">
              <div class="bc-section-body">${esc(p.summary)}</div>
              ${tagRow('Only ' + rivalName(b, p.rival_id), p.rival_only)}
              ${tagRow('Only ' + (b.brand?.name || run.brand), p.brand_only)}
              ${tagRow('Both', p.shared)}
            </div>`).join('')}
        </div>` : ''}

      ${!readOnly && run.warnings?.length ? `
        <div class="bc-reasoning">Server checks on the model's draft: ${run.warnings.map(esc).join(' ')}</div>` : ''}`;
  }

  function tagRow(label, tags) {
    if (!tags || !tags.length) return '';
    return `<div class="taste-tagrow"><span class="taste-tagrow-label">${esc(label)}</span><span class="bc-pattern-tags">${tags.slice(0, 8).map(t => `<span class="pattern-tag">${esc(t.name)}</span>`).join('')}</span></div>`;
  }

  function footer(run) {
    return `
      <div class="bc-footer">
        <a href="#/runs" class="btn btn-ghost btn-sm">All runs</a>
        <a href="#/taste" class="btn btn-ghost btn-sm">New brief</a>
        <span class="taste-hint taste-meta">${run.model ? esc(run.model) : ''}${run.turns ? ', ' + run.turns + ' turns' : ''}</span>
        ${viewCached ? '' : `<button class="btn btn-secondary btn-sm" type="button" style="margin-left:auto" onclick="Taste.rerun(${run.id})">Run again</button>`}
      </div>`;
  }

  function afterResults(run) {
    if (document.getElementById('taste-map')) {
      const ids = Object.keys(run.data.geo);
      geoRival = geoRival && ids.includes(geoRival) ? geoRival : ids[0];
      paintGeoTabs(run, ids);
      paintMap(run);
    }
    const demo = document.getElementById('taste-demo');
    if (demo) demo.innerHTML = demographics(run);
  }

  // ── Colors ──────────────────────────────────────────────────────────────────

  function vizColor(name) {
    const holder = document.querySelector('.taste-viz') || document.body;
    return getComputedStyle(holder).getPropertyValue(name).trim();
  }

  function hexToRgb(h) {
    const v = parseInt(h.replace('#', ''), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // Diverging: gap > 0 (rival leads) toward red, < 0 (we lead) toward blue,
  // gray at zero. Full color at a 40 point gap.
  function gapColor(gap) {
    const t = Math.max(-1, Math.min(1, (gap || 0) / 0.4));
    const mid = hexToRgb(vizColor('--div-mid'));
    const pole = hexToRgb(vizColor(t >= 0 ? '--div-rival' : '--div-ours'));
    const a = Math.abs(t);
    const c = mid.map((m, i) => Math.round(m + (pole[i] - m) * a));
    return 'rgb(' + c.join(',') + ')';
  }

  // ── Map ─────────────────────────────────────────────────────────────────────

  function paintGeoTabs(run, ids) {
    const tabs = document.getElementById('taste-geo-tabs');
    if (!tabs) return;
    tabs.innerHTML = ids.length < 2 ? '' : ids.map(id => `
      <button type="button" class="taste-tab ${id === geoRival ? 'active' : ''}" aria-pressed="${id === geoRival}"
        onclick="Taste.showGeo('${esc(id)}')">${esc(rivalName(run.brief, id))}</button>`).join('');
  }

  function showGeo(id) {
    if (!current?.data?.geo?.[id]) return;
    geoRival = id;
    paintGeoTabs(current, Object.keys(current.data.geo));
    paintMap(current);
  }

  function cellName(c) {
    return c.label || c.neighborhood || c.area || 'This area';
  }

  // The numbered hotspots for one rival: the brief's own, or else geo_gap's
  // top cells from the run data (labelled ones first). Runs stored before the
  // data carried hotspots fall back to the busiest cells with the widest
  // rival lead, picked the way geo_gap picks them.
  function hotspotsFor(run, rivalId) {
    const own = (run.brief.geo_hotspots || []).filter(h => !h.rival_id || h.rival_id === rivalId);
    if (own.length) return own;
    const g = run.data.geo[rivalId];
    let cells = g.hotspots || [];
    if (!cells.length) {
      const busy = g.cells.filter(c => (c.popularity || 0) >= 0.4);
      cells = [...(busy.length >= 12 ? busy : g.cells)].sort((a, b) => b.gap - a.gap);
    }
    const rival = rivalName(run.brief, rivalId);
    const ours = run.brief.brand?.name || run.brand;
    return [...cells.filter(c => c.label), ...cells.filter(c => !c.label)].slice(0, 5).map(c => ({
      ...c, note: rival + ' scores ' + num(pts(c.rival_affinity)) + ' here and ' + ours + ' scores ' + num(pts(c.our_affinity)) + '.',
    }));
  }

  function paintMap(run) {
    const el = document.getElementById('taste-map');
    const side = document.getElementById('taste-geo-side');
    if (!el || !window.L) return;
    cleanupMapOnly();
    const g = run.data.geo[geoRival];
    const brief = run.brief;
    const rival = rivalName(brief, geoRival);
    const ours = brief.brand?.name || run.brand;
    map = L.map(el, { scrollWheelZoom: false, attributionControl: true });
    // Standard OpenStreetMap tiles. Their usage policy needs a Referer, and
    // helmet's default Referrer-Policy is no-referrer, so the tiles carry
    // their own policy. Dark mode darkens the tile layer in CSS only.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);

    const ring = vizColor('--viz-surface');
    const bounds = [];
    for (const c of g.cells) {
      if (c.lat == null || c.lng == null) continue;
      bounds.push([c.lat, c.lng]);
      const radius = 4 + Math.round((c.popularity || 0) * 6);
      L.circleMarker([c.lat, c.lng], {
        radius, color: ring, weight: 1, fillColor: gapColor(c.gap), fillOpacity: 0.85,
      }).bindTooltip(
        `<strong>${esc(c.label || c.neighborhood || c.area || 'Map cell')}</strong><br>${esc(rival)} ${num(pts(c.rival_affinity))}, ${esc(ours)} ${num(pts(c.our_affinity))}<br>Gap ${signed(pts(c.gap))}`,
        { direction: 'top', className: 'taste-tip' },
      ).addTo(map);
    }

    // This rival's hotspots, numbered on the map and listed beside it. A cell
    // where our brand leads takes our end of the scale, as its dot does.
    const spots = hotspotsFor(run, geoRival);
    const oursLeads = h => typeof h.gap === 'number' && h.gap < 0;
    spots.forEach((h, i) => {
      if (h.lat == null || h.lng == null) return;
      L.marker([h.lat, h.lng], {
        icon: L.divIcon({ className: 'taste-pin' + (oursLeads(h) ? ' taste-pin--ours' : ''), html: '<span>' + (i + 1) + '</span>', iconSize: [24, 24], iconAnchor: [12, 12] }),
        keyboard: false,
      }).bindTooltip(`<strong>${esc(cellName(h))}</strong><br>${esc(h.note)}`, { direction: 'top', className: 'taste-tip' }).addTo(map);
    });

    if (bounds.length) map.fitBounds(bounds, { padding: [20, 20] });
    else map.setView([40.73, -73.99], 10);

    const st = g.stats || {};
    side.innerHTML = `
      <div class="taste-legend">
        <div class="taste-legend-bar" aria-hidden="true"></div>
        <div class="taste-legend-ends"><span>${esc(ours)} leads</span><span>Even</span><span>${esc(rival)} leads</span></div>
      </div>
      <div class="taste-geo-stats">
        <div><strong>${num(pts(st.share_rival_leads))}%</strong> of cells lean ${esc(rival)} by 10 or more</div>
        <div><strong>${num(pts(st.share_we_lead))}%</strong> lean ${esc(ours)} by 10 or more</div>
        <div class="taste-hint">${num(st.cells_compared)} cells compared in ${esc(g.locality?.name || run.city || 'the city')}. Dot size is how busy the area is.</div>
      </div>
      ${spots.length ? `
        <ol class="taste-spots">
          ${spots.map((h, i) => `
            <li>
              <span class="taste-spot-n${oursLeads(h) ? ' taste-spot-n--ours' : ''}">${i + 1}</span>
              <span><strong>${esc(cellName(h))}</strong>: ${esc(h.note)} <span class="taste-gap">(gap ${signed(pts(h.gap))})</span></span>
            </li>`).join('')}
        </ol>` : ''}`;
  }

  // ── Demographics chart ──────────────────────────────────────────────────────
  // Diverging horizontal bars around zero, one pair per group: our brand on
  // top, the rival below. Values -100 to 100, positive means over-indexed.

  function demographics(run) {
    const b = run.brief;
    const ours = b.brand?.name || run.brand;
    const blocks = Object.entries(run.data.demographics).map(([rid, d]) => {
      const rival = rivalName(b, rid);
      const rows = [...(d.age || []), ...(d.gender || [])];
      const bar = (v, cls, who) => {
        const n = pts(v);
        if (n == null) return `<span class="taste-bar ${cls} taste-bar--none"></span>`;
        const w = Math.min(50, Math.abs(n) / 2);
        const side = n >= 0 ? 'left:50%' : 'right:50%';
        return `<span class="taste-bar ${cls} ${n >= 0 ? 'pos' : 'neg'}" style="${side};width:${w}%" data-tip="${esc(who)}: ${signed(n)}"></span>`;
      };
      const note = (b.demographic_gap.find(x => x.rival_id === rid) || {}).summary;
      return `
        <div class="taste-demo-block">
          <div class="taste-legend-row">
            <span class="taste-key"><span class="taste-swatch taste-swatch--ours"></span>${esc(ours)}</span>
            <span class="taste-key"><span class="taste-swatch taste-swatch--rival"></span>${esc(rival)}</span>
            <span class="taste-hint">Over or under-indexed, minus 100 to 100</span>
          </div>
          ${note ? `<div class="bc-section-body taste-demo-note">${esc(note)}</div>` : ''}
          <div class="taste-chart" role="img" aria-label="Age and gender mix of ${esc(ours)} and ${esc(rival)} audiences">
            ${rows.map((r, i) => `
              ${i === (d.age || []).length ? '<div class="taste-chart-sep"></div>' : ''}
              <div class="taste-row" data-tip="${esc(AGE_LABEL[r.key] || r.key)}: ${esc(ours)} ${signed(pts(r.ours))}, ${esc(rival)} ${signed(pts(r.rival))}">
                <span class="taste-row-label">${esc(AGE_LABEL[r.key] || r.key)}</span>
                <span class="taste-row-plot">
                  <span class="taste-axis"></span>
                  ${bar(r.ours, 'taste-bar--ours', ours)}
                  ${bar(r.rival, 'taste-bar--rival', rival)}
                </span>
              </div>`).join('')}
            <div class="taste-row taste-row--ticks" aria-hidden="true">
              <span class="taste-row-label"></span>
              <span class="taste-row-plot taste-ticks"><span>-100</span><span>0</span><span>+100</span></span>
            </div>
          </div>
          <details class="taste-table-toggle">
            <summary>Show as table</summary>
            <table class="taste-ev">
              <thead><tr><th scope="col">Group</th><th scope="col">${esc(ours)}</th><th scope="col">${esc(rival)}</th><th scope="col">Gap</th></tr></thead>
              <tbody>${rows.map(r => `<tr><td>${esc(AGE_LABEL[r.key] || r.key)}</td><td>${signed(pts(r.ours))}</td><td>${signed(pts(r.rival))}</td><td class="taste-gap">${signed(pts(r.gap))}</td></tr>`).join('')}</tbody>
            </table>
          </details>
        </div>`;
    });
    return blocks.join('');
  }

  // One shared tooltip for chart rows (hit target is the whole row).
  let tip = null;
  document.addEventListener('mouseover', e => {
    const t = e.target.closest?.('.taste-row[data-tip]');
    if (!t) { if (tip) tip.hidden = true; return; }
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'taste-hover';
      document.body.appendChild(tip);
    }
    tip.textContent = t.getAttribute('data-tip');
    tip.hidden = false;
    const r = t.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2) + 'px';
    tip.style.top = (r.top - tip.offsetHeight - 6 + window.scrollY) + 'px';
  });

  // ── Actions ─────────────────────────────────────────────────────────────────

  // A fresh run of the same inputs (Run fresh, Run again): it skips the cache
  // and counts against the visitor's daily runs.
  async function rerun(id) {
    try {
      const { run } = await API.post('/taste/runs/' + id + '/rerun');
      navigate('#/taste/' + run.id);
    } catch (err) {
      if (err.code === 'busy' && err.id) { navigate('#/taste/' + err.id); return; }
      if (!featuredPairs.length) await loadFeatured();
      showNotice('taste-run-notice', friendlyMessage(err));
    }
  }

  function copy() {
    const run = current;
    if (!run?.brief) return;
    const b = run.brief;
    const lines = [b.headline, '', b.summary, '', 'Win these first:'];
    if (b.rival_choice) {
      const picked = b.rival_choice.candidates.filter(c => c.picked).map(c => c.name).join(' and ');
      lines.splice(2, 0, 'Rivals chosen by the agent: ' + picked + '. ' + b.rival_choice.reason, '');
    }
    for (const w of b.win_first) {
      lines.push(w.rank + '. ' + w.segment + ': ' + w.why + ' Campaign hook: ' + w.campaign_hook);
      if (w.lead) {
        const found = (w.lead.found || []).map(f => f.name + ' (' + pts(f.affinity) + ')');
        lines.push('   Lead followed: ' + w.lead.name + '. ' + (found.length ? 'Its fans also over-index on ' + andList(found) + ' (Qloo affinity, 0 to 100).' : ''));
      }
    }
    lines.push('', 'Segments the rival owns:');
    for (const s of b.rival_owned_segments) lines.push('- ' + s.segment + ': ' + s.insight);
    navigator.clipboard?.writeText(lines.join('\n'))
      .then(() => toast('Brief copied', 'success'))
      .catch(() => toast('Could not copy the brief', 'error'));
  }

  // ── Share and send ──────────────────────────────────────────────────────────
  // Share makes (or reuses) a public, read-only link to this brief. Send posts
  // a short summary with that link to the user's Slack or Discord webhook, and
  // asks for one inline when none is saved. On the shared demo account both are
  // kept per browser session, so judges never see each other's links or
  // channels.

  const CHANNEL = { slack: 'Slack', discord: 'Discord' };

  function sharePanel(runId, link) {
    const box = document.getElementById('taste-share-panel');
    if (!box) return;
    box.innerHTML = link ? `
      <div class="bc-section taste-share">
        <div class="bc-section-label">Share this brief</div>
        <div class="taste-hint">Anyone with the link can read the brief, the map and the chart without logging in. Search engines are asked not to index it.</div>
        <div class="taste-share-row">
          <input class="form-input" id="taste-share-url" readonly value="${esc(link.url)}" aria-label="Share link" onfocus="this.select()">
          <button class="btn btn-primary btn-sm" type="button" onclick="Taste.copyShare()">Copy link</button>
        </div>
        <div class="taste-share-foot">
          <a href="${esc(link.url)}" target="_blank" rel="noopener">Open the shared page</a>
          <button class="btn btn-ghost btn-sm" type="button" onclick="Taste.revokeShare(${runId})">Revoke link</button>
        </div>
      </div>` : `
      <div class="bc-section taste-share">
        <div class="bc-section-label">Link revoked</div>
        <div class="bc-section-body">Anyone who opens the old link now sees that the brief is no longer available.</div>
        <div class="taste-share-foot">
          <button class="btn btn-secondary btn-sm" type="button" onclick="Taste.share(${runId})">Make a new link</button>
        </div>
      </div>`;
  }

  async function share(id) {
    try {
      const { share: link } = await API.post('/taste/runs/' + id + '/share');
      sharePanel(id, link);
      document.getElementById('taste-share-panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      toast(friendlyMessage(err), 'error');
    }
  }

  async function revokeShare(id) {
    try {
      await API.delete('/taste/runs/' + id + '/share');
      sharePanel(id, null);
      toast('Link revoked', 'success');
    } catch (err) {
      toast(friendlyMessage(err), 'error');
    }
  }

  function copyShare() {
    const input = document.getElementById('taste-share-url');
    if (!input) return;
    const fallback = () => { input.focus(); input.select(); toast('Link selected, copy it from there', 'info'); };
    if (!navigator.clipboard) return fallback();
    navigator.clipboard.writeText(input.value).then(() => toast('Link copied', 'success'), fallback);
  }

  function webhookForm(id, error) {
    const box = document.getElementById('taste-share-panel');
    if (!box) return;
    const sessionOnly = Boolean(window.App?.user?.is_demo);
    box.innerHTML = `
      <form class="bc-section taste-share" onsubmit="Taste.sendWithWebhook(event, ${id})" novalidate>
        <div class="bc-section-label">Send to Slack or Discord</div>
        <div class="bc-section-body">No webhook is saved yet. Paste an incoming webhook from Slack or Discord and the summary goes out right away.</div>
        <div class="taste-share-row">
          <input class="form-input" id="taste-webhook" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"
            placeholder="https://hooks.slack.com/services/..." aria-label="Slack or Discord webhook URL" required>
          <button class="btn btn-primary btn-sm" type="submit" id="taste-webhook-send">Save and send</button>
        </div>
        ${error ? `<div class="taste-share-error" role="alert">${esc(error)}</div>` : ''}
        <div class="taste-hint">${sessionOnly
          ? 'This is the shared demo account, so the webhook is kept for this browser session only. Other visitors never see it.'
          : 'It is saved under Profile, Integrations, where you can change or remove it.'}</div>
      </form>`;
    document.getElementById('taste-webhook')?.focus();
  }

  async function send(id, webhook) {
    const buttons = ['taste-send-btn', 'taste-webhook-send'].map(b => document.getElementById(b)).filter(Boolean);
    const labels = buttons.map(b => b.textContent);
    for (const b of buttons) { b.disabled = true; b.textContent = 'Sending...'; }
    try {
      const res = await API.post('/taste/runs/' + id + '/send', webhook ? { webhook } : {});
      sharePanel(id, res.share);
      toast('Sent to ' + res.sent.map(k => CHANNEL[k]).join(' and '), 'success');
      if (res.failed?.length) toast(res.failed.map(k => CHANNEL[k]).join(' and ') + ' did not accept the message', 'error');
    } catch (err) {
      if (err.code === 'no_webhook') webhookForm(id);
      else if (err.code === 'bad_webhook') webhookForm(id, err.message);
      else {
        if (err.share) sharePanel(id, err.share);
        toast(friendlyMessage(err), 'error');
      }
    } finally {
      buttons.forEach((b, i) => { if (b.isConnected) { b.disabled = false; b.textContent = labels[i]; } });
    }
  }

  function sendWithWebhook(e, id) {
    e.preventDefault();
    const url = document.getElementById('taste-webhook')?.value.trim();
    if (!url) { webhookForm(id, 'Paste a webhook URL first.'); return; }
    send(id, url);
  }

  // The public page behind a share link (public/js/share.js): the brief, map
  // and chart, read-only, with no actions, trace or server notes.
  function renderShared(run, target) {
    readOnly = true;
    current = run;
    viewCached = false;
    geoRival = null;
    document.title = run.brand + ' vs ' + run.rivals.join(' and ') + ' · Nivaria';
    target.innerHTML = `<div class="bc-wrap taste-wrap">${header(run)}${results(run)}</div>`;
    afterResults(run);
  }

  // ── Runs history ────────────────────────────────────────────────────────────

  async function renderRuns() {
    cleanup();
    let list = [];
    try {
      ({ runs: list } = await API.get('/taste/runs'));
    } catch (e) {
      toast(e.message, 'error');
    }
    el('topbar-actions').innerHTML = '<a href="#/taste" class="btn btn-primary btn-sm">New brief</a>';
    if (!list.length) {
      root().innerHTML = `<div class="empty-state">
        <div class="empty-title">No runs yet</div>
        <div class="empty-desc">Run your first brief to see where a rival's audience is that yours is not.</div>
        <a class="btn btn-primary" href="#/taste">New brief</a>
      </div>`;
      return;
    }
    root().innerHTML = `
      <div class="table-wrap cards-sm">
        <table>
          <thead><tr><th>Brief</th><th>City</th><th>Status</th><th>Started</th><th>Took</th><th></th></tr></thead>
          <tbody>
            ${list.map(r => `
              <tr>
                <td class="cell-title" data-label="Brief">
                  <a href="#/taste/${r.id}" class="taste-run-link">
                    <span class="td-primary">${brandLine(r)}</span>
                    <span class="taste-run-sub">${esc(r.headline || r.error_message || (r.status === 'running' ? 'Running now' : ''))}</span>
                  </a>
                </td>
                <td data-label="City">${esc(r.city || 'None')}</td>
                <td data-label="Status">${statusBadge(r.status)}</td>
                <td data-label="Started" title="${esc(formatDate(r.created_at))}">${timeAgo(r.created_at)}</td>
                <td data-label="Took">${r.duration_ms ? secs(r.duration_ms) : ''}</td>
                <td data-label="">
                  <div class="td-actions">
                    <a href="#/taste/${r.id}" class="btn btn-ghost btn-sm">Open</a>
                    ${r.status === 'running' ? '' : `<button type="button" class="btn btn-ghost btn-sm" onclick="Taste.rerun(${r.id})">Run again</button>`}
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  async function render(id, query) {
    cleanup();
    return id ? renderRun(id, { cached: query?.get('cached') === '1' }) : renderForm();
  }

  return { render, renderRuns, renderShared, rerun, copy, showGeo, markFallback, share, revokeShare, copyShare, send, sendWithWebhook, openTrace };
})();
window.Taste = Taste;
