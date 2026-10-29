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

  const pts = x => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) : null);
  const signed = n => (n == null ? 'n/a' : (n > 0 ? '+' : '') + n);
  const secs = ms => (ms == null ? '' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's');
  const num = n => (n == null ? 'n/a' : String(n));

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
      [status, { runs: recent }] = await Promise.all([API.get('/taste/status'), API.get('/taste/runs')]);
    } catch (e) {
      toast(e.message, 'error');
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

        ${status.ready ? '' : `
          <div class="bc-section taste-notice">
            <div class="bc-section-label">Not ready on this server</div>
            <div class="bc-section-body">${esc(status.problem)}</div>
          </div>`}

        ${running ? `
          <div class="bc-section taste-notice">
            <div class="bc-section-body">
              A run is going: <strong>${brandLine(running)}</strong>.
              <a href="#/taste/${running.id}">Watch it</a>
            </div>
          </div>` : ''}

        <form class="bc-section taste-form" id="taste-form" novalidate>
          <div class="bc-section-label">New brief</div>
          <div class="taste-form-grid">
            <div class="form-group">
              <label class="form-label" for="taste-brand">Your brand</label>
              <input class="form-input" id="taste-brand" name="brand" maxlength="80" autocomplete="off" placeholder="Glossier" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="taste-rival">Rival</label>
              <input class="form-input" id="taste-rival" name="rival" maxlength="80" autocomplete="off" placeholder="Fenty Beauty" required>
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
            <span class="taste-hint">Only these names are sent to the model. A run takes up to three minutes.</span>
            <button class="btn btn-primary" type="submit" id="taste-submit" ${status.ready && !running ? '' : 'disabled'}>Run the brief</button>
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
    document.getElementById('taste-brand').focus();
  }

  async function submit(e) {
    e.preventDefault();
    const f = e.target;
    const brand = f.brand.value.trim();
    const rivals = [f.rival.value.trim(), f.rival2.value.trim()].filter(Boolean);
    if (!brand || !rivals.length) { toast('Enter your brand and at least one rival.', 'error'); return; }
    const btn = document.getElementById('taste-submit');
    btn.disabled = true;
    btn.textContent = 'Starting...';
    try {
      const { run } = await API.post('/taste/runs', { brand, rivals, city: f.city.value.trim() });
      navigate('#/taste/' + run.id);
    } catch (err) {
      toast(err.message, 'error');
      if (err.id) navigate('#/taste/' + err.id);
      btn.disabled = false;
      btn.textContent = 'Run the brief';
    }
  }

  // ── Run page ────────────────────────────────────────────────────────────────

  async function renderRun(id) {
    let run;
    try {
      ({ run } = await API.get('/taste/runs/' + encodeURIComponent(id)));
    } catch (e) {
      root().innerHTML = `<div class="empty-state">
        <div class="empty-title">Run not found</div>
        <div class="empty-desc">${esc(e.message)}</div>
        <a class="btn btn-primary" href="#/runs">All runs</a>
      </div>`;
      return;
    }
    current = run;
    geoRival = null;
    paintRun(run);
    if (run.status === 'running') openStream(run.id, run.steps || []);
  }

  function header(run) {
    const label = run.status === 'done' ? 'Brief ready' : run.status === 'error' ? 'Run failed' : 'Running';
    const cls = run.status === 'done' ? 'taste-state--done' : run.status === 'error' ? 'taste-state--error' : 'taste-state--running';
    const brand = run.brief?.brand;
    return `
      <div class="bc-header">
        <div class="bc-left">
          ${brand?.image ? `<img class="taste-logo" src="${esc(brand.image)}" alt="" width="52" height="52">` : avatarHtml(run.brand, 52)}
          <div>
            <div class="bc-comp-name">${brandLine(run)}</div>
            <div class="taste-sub">${run.city ? 'In ' + esc(run.city) : 'No city, so no places or map'}</div>
          </div>
        </div>
        <div class="bc-threat ${cls}">
          <div class="bc-threat-label">${label}</div>
          <div class="bc-threat-date">${formatDate(run.created_at)}</div>
        </div>
      </div>`;
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
        <div class="bc-section taste-notice taste-notice--error">
          <div class="bc-section-label">What went wrong</div>
          <div class="bc-section-body">${esc(run.error_message || 'The run failed.')}</div>
        </div>
        ${traceSection(run, true)}
        ${footer(run)}`;
    } else {
      body = results(run) + traceSection(run, false) + footer(run);
    }
    root().innerHTML = `<div class="bc-wrap taste-wrap">${header(run)}${body}</div>`;
    if (run.status === 'done') afterResults(run);
  }

  function cleanupMapOnly() {
    if (map) { map.remove(); map = null; }
  }

  // ── Live trace ──────────────────────────────────────────────────────────────

  function traceItem(s) {
    const icon = s.kind === 'switch' ? ICON.swap : s.kind === 'note' ? ICON.note
      : s.status === 'running' ? ICON.spin : s.status === 'error' ? ICON.err : ICON.ok;
    const cls = 'taste-step taste-step--' + (s.kind === 'tool' ? s.status : s.kind);
    return `
      <li class="${cls}">
        <span class="taste-step-icon">${icon}</span>
        <span class="taste-step-main">
          <span class="taste-step-label">${esc(s.label)}</span>
          ${s.summary && s.kind !== 'note' ? `<span class="taste-step-sum">${esc(s.summary)}</span>` : ''}
        </span>
        <span class="taste-step-time">${s.status === 'running' ? '' : secs(s.ms)}</span>
      </li>`;
  }

  function traceItems(list) {
    const shown = list.filter(Boolean);
    if (!shown.length) return '<li class="taste-step taste-step--running"><span class="taste-step-icon">' + ICON.spin + '</span><span class="taste-step-main"><span class="taste-step-label">Starting the agent</span></span></li>';
    return shown.map(traceItem).join('');
  }

  function traceSection(run, open) {
    const list = (run.steps || []).filter(Boolean);
    if (!list.length) return '';
    const tools = list.filter(s => s.kind === 'tool').length;
    return `
      <details class="bc-section taste-trace-wrap" ${open ? 'open' : ''}>
        <summary class="bc-section-label taste-summary">Agent trace: ${tools} tool calls${run.duration_ms ? ' in ' + secs(run.duration_ms) : ''}</summary>
        <ol class="taste-trace">${list.map(traceItem).join('')}</ol>
      </details>`;
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
        paintRun(run);
        if (run.status === 'done') toast('Brief ready', 'success');
      } catch (err) { toast(err.message, 'error'); }
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
              <td>${esc(e.kind === 'cell' ? (e.neighborhood || e.area || 'Map cell') : e.name)}</td>
              <td>${num(pts(e.rival_affinity))}</td>
              <td>${num(pts(e.our_affinity))}</td>
              <td class="taste-gap">${signed(pts(e.gap))}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function confidenceBadge(c) {
    const label = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }[c] || '';
    return label ? `<span class="badge ${c === 'high' ? 'badge-accent' : 'badge-neutral'}">${label}</span>` : '';
  }

  function results(run) {
    const b = run.brief;
    const hasGeo = run.data && Object.keys(run.data.geo || {}).length > 0;
    const hasDemo = run.data && Object.keys(run.data.demographics || {}).length > 0;
    return `
      <div class="bc-headline-wrap">
        <h2 class="bc-headline">${esc(b.headline)}</h2>
        <div class="bc-headline-actions">
          <button class="btn btn-ghost btn-sm" type="button" onclick="Taste.copy()">Copy brief</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="Taste.rerun(${run.id})">Run again</button>
        </div>
      </div>

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
                ${(w.channels || []).length ? `<div class="bc-pattern-tags">${w.channels.map(c => `<span class="pattern-tag">${esc(c)}</span>`).join('')}</div>` : ''}
              </div>
            </li>`).join('')}
        </ol>
      </div>

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

      ${run.warnings?.length ? `
        <div class="bc-reasoning">Dropped by the citation check: ${run.warnings.map(esc).join('; ')}</div>` : ''}`;
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
        <button class="btn btn-secondary btn-sm" type="button" style="margin-left:auto" onclick="Taste.rerun(${run.id})">Run again</button>
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

  function paintMap(run) {
    const el = document.getElementById('taste-map');
    const side = document.getElementById('taste-geo-side');
    if (!el || !window.L) return;
    cleanupMapOnly();
    const g = run.data.geo[geoRival];
    const brief = run.brief;
    const rival = rivalName(brief, geoRival);
    const ours = brief.brand?.name || run.brand;
    const light = document.documentElement.getAttribute('data-theme') === 'light';

    map = L.map(el, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/' + (light ? 'light_all' : 'dark_all') + '/{z}/{x}/{y}{r}.png', {
      maxZoom: 18,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
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
        `<strong>${esc(c.neighborhood || c.area || 'Map cell')}</strong><br>${esc(rival)} ${num(pts(c.rival_affinity))}, ${esc(ours)} ${num(pts(c.our_affinity))}<br>Gap ${signed(pts(c.gap))}`,
        { direction: 'top', className: 'taste-tip' },
      ).addTo(map);
    }

    // The brief's hotspots for this rival, numbered on the map and listed beside it.
    const spots = brief.geo_hotspots.filter(h => !h.rival_id || h.rival_id === geoRival);
    spots.forEach((h, i) => {
      if (h.lat == null || h.lng == null) return;
      L.marker([h.lat, h.lng], {
        icon: L.divIcon({ className: 'taste-pin', html: '<span>' + (i + 1) + '</span>', iconSize: [24, 24], iconAnchor: [12, 12] }),
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
              <span class="taste-spot-n">${i + 1}</span>
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

  async function rerun(id) {
    try {
      const { run } = await API.post('/taste/runs/' + id + '/rerun');
      navigate('#/taste/' + run.id);
    } catch (err) {
      toast(err.message, 'error');
      if (err.id) navigate('#/taste/' + err.id);
    }
  }

  function copy() {
    const run = current;
    if (!run?.brief) return;
    const b = run.brief;
    const lines = [b.headline, '', b.summary, '', 'Win these first:'];
    for (const w of b.win_first) lines.push(w.rank + '. ' + w.segment + ': ' + w.why + ' Campaign hook: ' + w.campaign_hook);
    lines.push('', 'Segments the rival owns:');
    for (const s of b.rival_owned_segments) lines.push('- ' + s.segment + ': ' + s.insight);
    navigator.clipboard?.writeText(lines.join('\n'))
      .then(() => toast('Brief copied', 'success'))
      .catch(() => toast('Could not copy the brief', 'error'));
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
        <div class="empty-desc">Run your first Taste Gap brief to see where a rival's audience is that yours is not.</div>
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

  async function render(id) {
    cleanup();
    return id ? renderRun(id) : renderForm();
  }

  return { render, renderRuns, rerun, copy, showGeo };
})();
window.Taste = Taste;
