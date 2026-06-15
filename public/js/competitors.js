const Competitors = {
  async render() {
    el('topbar-actions').innerHTML = `
      <button class="btn btn-primary btn-sm" onclick="Competitors.showAddModal()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Competitor
      </button>`;

    try {
      const competitors = await API.getCompetitors();
      el('page-root').innerHTML = Competitors.html(competitors);
      window.staggerIn?.('tbody tr', 30, 50);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Error loading competitors</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
    }
  },

  html(competitors) {
    if (competitors.length === 0) {
      return `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div class="empty-title">No competitors yet</div>
          <div class="empty-desc">Add your first competitor URL to start monitoring for changes and generating briefs.</div>
          <div class="empty-desc" style="max-width:520px;margin-top:8px;">Nivaria monitors and analyzes publicly available information such as website content, pricing pages, product announcements, and messaging changes. We do not access private accounts, bypass authentication, or collect non-public data.</div>
          <button class="btn btn-primary" onclick="Competitors.showAddModal()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add First Competitor
          </button>
        </div>
      `;
    }

    // Render both layouts and let CSS switch at 768px:
    //   .competitors-table-view → desktop (preserves the existing table exactly)
    //   .competitors-card-view  → mobile <768px (designed card stack)
    // Negligible DOM cost for typical 5-10 competitors; keeps a single render()
    // source of truth and lets each layout be designed semantically.
    return `
      <div class="competitors-table-view">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Competitor</th>
                <th>URL</th>
                <th>Status</th>
                <th>Last Checked</th>
                <th>Changes</th>
                <th>Last Alert</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${competitors.map(c => `
                <tr>
                  <td>
                    <div class="comp-name-cell">
                      ${avatarHtml(c.name, 32)}
                      <div>
                        <div class="td-primary">
                          <a href="#/competitors/${c.id}" style="color:inherit;text-decoration:none">${esc(c.name)}</a>
                          ${c.css_selector ? `<span class="scoped-badge" title="Monitoring scoped to: ${esc(c.css_selector)}">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                            scoped
                          </span>` : ''}
                        </div>
                        ${c.description ? `<div class="td-sub">${esc(c.description.substring(0, 55))}${c.description.length > 55 ? '…' : ''}</div>` : ''}
                      </div>
                    </div>
                  </td>
                  <td>
                    <a href="${esc(c.url)}" target="_blank" class="comp-url-link" title="${esc(c.url)}">
                      ${esc(c.url.replace(/^https?:\/\//, '').substring(0, 42))}${c.url.length > 48 ? '…' : ''}
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                  </td>
                  <td>${Competitors.statusPill(c)}</td>
                  <td class="text-muted text-sm">${c.last_checked ? timeAgo(c.last_checked) : 'Pending first check'}</td>
                  <td>
                    ${c.change_count > 0
                      ? `<a href="#/history?competitor_id=${c.id}" class="change-count-link">${c.change_count}</a>`
                      : `<span class="text-muted">0</span>`
                    }
                  </td>
                  <td>
                    ${c.last_threat ? `
                      <div style="display:flex;flex-direction:column;gap:4px">
                        ${threatBadge(c.last_threat)}
                        <span class="text-sm" style="color:var(--txt-3)">${timeAgo(c.last_change_at)}</span>
                      </div>
                    ` : '<span class="text-muted">-</span>'}
                  </td>
                  <td>
                    <div class="td-actions">
                      <button class="btn btn-secondary btn-sm" onclick="Competitors.check(${c.id}, this)" title="Check now">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        Check
                      </button>
                      <button class="btn btn-ghost btn-sm" onclick="Competitors.showEditModal(${c.id})" title="Edit">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                      <button class="btn btn-ghost btn-sm" onclick="Competitors.toggle(${c.id}, this)" title="${c.active ? 'Pause' : 'Resume'}">
                        ${c.active
                          ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
                          : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
                        }
                      </button>
                      <button class="btn btn-danger btn-sm" onclick="Competitors.remove(${c.id}, '${esc(c.name)}')" title="Delete">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="competitors-card-view">
        ${competitors.map(c => Competitors.cardHtml(c)).join('')}
      </div>

      <p class="text-muted text-sm mt-16 comp-footnote">
        ${App.user?.tier === 'free'
          ? `Free plan: 1 competitor. <a href="#/pricing" style="color:var(--accent-2)">Upgrade to Pro for 10</a> or <a href="#/pricing" style="color:var(--accent-2)">Team for 60</a>.`
          : App.user?.tier === 'pro'
          ? `Pro plan: up to 10 competitors. <a href="#/pricing" style="color:var(--accent-2)">Upgrade to Team for 60</a>.`
          : 'Team plan: 60 competitors.'
        }
      </p>
    `;
  },

  // Mobile card for a single competitor. Same data as the table row, designed
  // for thumb-tap and at-a-glance scanning rather than column comparison.
  //   • Name (large, links to detail) + URL (small, truncated, external link)
  //   • Status pill on its own row
  //   • Labeled metadata rows: Last checked, Changes, Last alert (if any)
  //   • Primary "Check now" button (full-width, ≥44px)
  //   • 3-dot menu for less-common actions (Edit / Pause-Resume / Delete) —
  //     inline disclosure, no popover or modal so it sidesteps the Phase G
  //     bottom-sheet refactor cleanly.
  cardHtml(c) {
    const urlNoProto = c.url.replace(/^https?:\/\//, '');
    const urlShort   = urlNoProto.length > 38 ? urlNoProto.substring(0, 38) + '…' : urlNoProto;
    const lastChecked = c.last_checked ? timeAgo(c.last_checked) : 'Pending first check';
    const lastChangeAt = c.last_change_at ? timeAgo(c.last_change_at) : '';
    return `
      <article class="comp-card" data-comp-id="${c.id}">
        <div class="comp-card-head">
          ${avatarHtml(c.name, 38)}
          <div class="comp-card-title">
            <a href="#/competitors/${c.id}" class="comp-card-name">
              ${esc(c.name)}
              ${c.css_selector ? `<span class="scoped-badge" title="Monitoring scoped to: ${esc(c.css_selector)}">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                scoped
              </span>` : ''}
            </a>
            <a href="${esc(c.url)}" target="_blank" rel="noopener" class="comp-card-url" title="${esc(c.url)}">
              <span class="comp-card-url-text">${esc(urlShort)}</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          </div>
          <button class="comp-card-kebab" type="button"
                  aria-label="More actions for ${esc(c.name)}"
                  aria-expanded="false"
                  onclick="Competitors.toggleCardMenu(${c.id}, this)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/>
            </svg>
          </button>
        </div>

        <div class="comp-card-status-row">${Competitors.statusPill(c)}</div>

        ${c.description ? `<p class="comp-card-desc">${esc(c.description)}</p>` : ''}

        <dl class="comp-card-meta">
          <div class="comp-meta-row">
            <dt class="comp-meta-label">Last checked</dt>
            <dd class="comp-meta-val">${lastChecked}</dd>
          </div>
          <div class="comp-meta-row">
            <dt class="comp-meta-label">Changes</dt>
            <dd class="comp-meta-val">
              ${c.change_count > 0
                ? `<a href="#/history?competitor_id=${c.id}" class="comp-meta-link">${c.change_count} detected</a>`
                : `<span class="text-muted">0</span>`}
            </dd>
          </div>
          ${c.last_threat ? `
            <div class="comp-meta-row">
              <dt class="comp-meta-label">Last alert</dt>
              <dd class="comp-meta-val">${threatBadge(c.last_threat)}${lastChangeAt ? `<span class="text-muted" style="margin-left:8px;font-size:12px">${lastChangeAt}</span>` : ''}</dd>
            </div>` : ''}
        </dl>

        <div class="comp-card-actions">
          <button class="btn btn-primary comp-card-check" onclick="Competitors.check(${c.id}, this)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Check now
          </button>
        </div>

        <div class="comp-card-menu" id="comp-card-menu-${c.id}" hidden>
          <button class="comp-card-menu-item" onclick="Competitors.closeCardMenu(${c.id});Competitors.showEditModal(${c.id})">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit details
          </button>
          <button class="comp-card-menu-item" onclick="Competitors.closeCardMenu(${c.id});Competitors.toggle(${c.id}, this)">
            ${c.active
              ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause monitoring`
              : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume monitoring`}
          </button>
          <button class="comp-card-menu-item comp-card-menu-item--danger" onclick="Competitors.closeCardMenu(${c.id});Competitors.remove(${c.id}, '${esc(c.name)}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            Delete competitor
          </button>
        </div>
      </article>
    `;
  },

  // Inline 3-dot menu disclosure. No popover positioning, no scrim — the menu
  // expands inside the card. Mutually exclusive: opening one closes any other
  // open menu so the card stack stays scannable.
  toggleCardMenu(id, btn) {
    const menu = el(`comp-card-menu-${id}`);
    if (!menu) return;
    const willOpen = menu.hasAttribute('hidden');
    document.querySelectorAll('.comp-card-menu').forEach(m => {
      m.setAttribute('hidden', '');
      const parent = m.closest('.comp-card');
      parent?.querySelector('.comp-card-kebab')?.setAttribute('aria-expanded', 'false');
    });
    if (willOpen) {
      menu.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', 'true');
    }
  },

  closeCardMenu(id) {
    const menu = el(`comp-card-menu-${id}`);
    if (!menu) return;
    menu.setAttribute('hidden', '');
    menu.closest('.comp-card')?.querySelector('.comp-card-kebab')?.setAttribute('aria-expanded', 'false');
  },

  statusPill(c) {
    if (!c.active) {
      return `<span class="status-pill status-pill--paused"><span class="status-dot"></span>Paused</span>`;
    }
    const s = c.last_check_status || '';
    // last_check_error now holds a human-friendly message (set by the scraper's
    // error classifier), so it's safe to surface directly as the tooltip.
    const tip = c.last_check_error ? ` title="${esc(c.last_check_error)}"` : '';
    const pill = (cls, label) =>
      `<span class="status-pill status-pill--${cls}"${tip}><span class="status-dot"></span>${label}</span>`;

    // Map each error_type/status to a short pill label + a reused pill colour.
    // The full human message is in the tooltip; the label stays terse. `ok_*`
    // is handled separately below (successful fetch, AI fell back).
    const PILL = {
      ssrf_blocked:       ['blocked',          'Private address'],
      access_denied:      ['blocked',          'Access denied'],
      anti_bot:           ['blocked',          'Anti-bot'],
      blocked:            ['blocked',          'Blocked'],          // legacy rows
      dns_nxdomain:       ['fetch-error',      'DNS error'],
      connection_failed:  ['fetch-error',      "Can't connect"],
      server_error:       ['fetch-error',      'Server error'],
      http_error:         ['fetch-error',      'HTTP error'],
      render_failed:      ['fetch-error',      'Render error'],     // legacy rows
      fetch_failed:       ['fetch-error',      'Fetch error'],
      empty_content:      ['empty',            'Empty'],
      selector_not_found: ['selector-missing', 'Selector not found'],
    };
    if (PILL[s]) {
      const [cls, label] = PILL[s];
      return pill(cls, label);
    }
    if (s.startsWith('ok_')) {
      // Successful fetch but AI analysis fell back (ok_ai_out_of_credits, ok_no_ai_key, etc.)
      return pill('ai-down', 'AI down');
    }
    return `<span class="status-pill status-pill--active"><span class="status-dot"></span>Active</span>`;
  },

  showAddModal() {
    openModal(`
      <div class="modal-header">
        <div class="modal-title">Add Competitor</div>
        <button class="modal-close" onclick="closeModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Competitor Name <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="comp-name" placeholder="e.g. Acme Corp" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">Page URL to Monitor <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="comp-url" placeholder="https://competitor.com/pricing or /changelog" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" />
          <span class="form-hint">Pricing pages, changelogs, and blogs work best. Heavily bot-protected sites may not be monitorable on this plan.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Internal Notes <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="comp-desc" placeholder="e.g. Primary rival in the SMB market" />
        </div>
        <div class="form-group">
          <label class="form-label">CSS selector <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="comp-selector" placeholder=".pricing-table or #features" maxlength="200" />
          <span class="form-hint">Advanced. Monitor only a specific section of the page. Leave blank to watch the whole page. Use your browser's Inspect tool to find the right selector.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Rendering mode</label>
          ${Competitors.renderModeRadios('comp-render-mode', 'fetch')}
          <span class="form-hint">Switch to JavaScript mode if Fast mode shows "no content found" or you know the page is built with React, Vue, Webflow, or similar.</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="Competitors.submitAdd(this)">Add Competitor</button>
      </div>
    `);

    setTimeout(() => el('comp-name').focus(), 50);
    el('comp-url').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.querySelector('.modal-footer .btn-primary').click();
    });
  },

  // Inline component: rendering-mode radios. Caller supplies a unique field name
  // (so add/edit modals can coexist if ever shown together) and the current value.
  renderModeRadios(fieldName, current) {
    const c = current === 'js' ? 'js' : 'fetch';
    return `
      <div class="render-mode-group" style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
          <input type="radio" name="${fieldName}" value="fetch" ${c === 'fetch' ? 'checked' : ''} style="margin-top:3px"/>
          <span>
            <span style="display:block;color:var(--txt);font-weight:500">Fast (HTML fetch)</span>
            <span style="display:block;color:var(--txt-3);font-size:12px;margin-top:2px">Default, recommended for most sites</span>
          </span>
        </label>
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
          <input type="radio" name="${fieldName}" value="js" ${c === 'js' ? 'checked' : ''} style="margin-top:3px"/>
          <span>
            <span style="display:block;color:var(--txt);font-weight:500">JavaScript (slower)</span>
            <span style="display:block;color:var(--txt-3);font-size:12px;margin-top:2px">For modern SaaS pages where content loads dynamically</span>
          </span>
        </label>
      </div>
    `;
  },

  selectedRenderMode(fieldName) {
    const chosen = document.querySelector(`input[name="${fieldName}"]:checked`);
    return chosen?.value === 'js' ? 'js' : 'fetch';
  },

  async submitAdd(btn) {
    const name       = el('comp-name').value.trim();
    const url        = el('comp-url').value.trim();
    const desc       = el('comp-desc').value.trim();
    const selector   = el('comp-selector')?.value.trim() || '';
    const renderMode = Competitors.selectedRenderMode('comp-render-mode');

    if (!name) { toast('Name is required', 'error'); return; }
    if (!url)  { toast('URL is required', 'error'); return; }
    if (selector.length > 200) { toast('CSS selector must be 200 characters or fewer', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Adding…';

    try {
      await API.addCompetitor({
        name,
        url,
        description: desc || undefined,
        css_selector: selector || undefined,
        render_mode: renderMode,
      });
      closeModal();
      toast(`${name} added successfully`, 'success');
      Competitors.render();
      const stats = await API.getStats();
      App.stats = stats;
      App.updateBadges();
    } catch (e) {
      // A 402 upgrade_required is surfaced centrally by api.js, which opens the
      // tier-aware upgrade-gate modal in place of this add-modal. Don't also
      // toast/redirect — just defer to that modal.
      if (e.error === 'upgrade_required') return;
      btn.disabled = false;
      btn.textContent = 'Add Competitor';
      toast(e.message, 'error');
    }
  },

  async showEditModal(id) {
    let c;
    try {
      const all = await API.getCompetitors();
      c = all.find(x => x.id === id);
    } catch (e) { toast(e.message, 'error'); return; }
    if (!c) { toast('Competitor not found', 'error'); return; }

    const currentMode = c.render_mode === 'js' ? 'js' : 'fetch';
    // Surface a JS-mode hint when the last check failed for an extraction reason
    // while we were in fetch mode — this is the exact failure shape that switching
    // to Playwright is built to fix.
    const showJsHint = currentMode === 'fetch'
      && (c.last_check_status === 'selector_not_found' || c.last_check_status === 'empty_content');

    openModal(`
      <div class="modal-header">
        <div class="modal-title">Edit Competitor</div>
        <button class="modal-close" onclick="closeModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        ${showJsHint ? `
          <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.35);border-radius:6px;padding:10px 12px;margin-bottom:14px;color:var(--txt-2);font-size:13px;line-height:1.5">
            <strong style="color:var(--txt)">Try switching to JavaScript rendering.</strong>
            The last check failed (${esc(c.last_check_status === 'selector_not_found' ? 'selector not found' : 'empty content')}) while using Fast mode. If this page is built with React, Vue, Webflow, or similar, content loads after the initial HTML and Fast mode can't see it.
          </div>` : ''}
        <div class="form-group">
          <label class="form-label">Competitor Name <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="edit-comp-name" value="${esc(c.name)}" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">Page URL to Monitor <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="edit-comp-url" value="${esc(c.url)}" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" />
          <span class="form-hint">Changing the URL will reset the baseline so the next check captures the new page.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Internal Notes <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="edit-comp-desc" value="${esc(c.description || '')}" />
        </div>
        <div class="form-group">
          <label class="form-label">CSS selector <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="edit-comp-selector" value="${esc(c.css_selector || '')}" placeholder=".pricing-table or #features" maxlength="200" />
          <span class="form-hint">Advanced. Monitor only a specific section of the page. Clear this field to revert to full-page monitoring. Changing it will reset the baseline.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Rendering mode</label>
          ${Competitors.renderModeRadios('edit-comp-render-mode', currentMode)}
          <span class="form-hint">Switch to JavaScript mode if Fast mode shows "no content found" or you know the page is built with React, Vue, Webflow, or similar. Changing this resets the baseline.</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="Competitors.submitEdit(${id}, this)">Save Changes</button>
      </div>
    `);
    setTimeout(() => el('edit-comp-name').focus(), 50);
  },

  async submitEdit(id, btn) {
    const name       = el('edit-comp-name').value.trim();
    const url        = el('edit-comp-url').value.trim();
    const desc       = el('edit-comp-desc').value.trim();
    const selector   = el('edit-comp-selector').value.trim();
    const renderMode = Competitors.selectedRenderMode('edit-comp-render-mode');

    if (!name) { toast('Name is required', 'error'); return; }
    if (!url)  { toast('URL is required', 'error'); return; }
    if (selector.length > 200) { toast('CSS selector must be 200 characters or fewer', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      await API.updateCompetitor(id, {
        name,
        url,
        description: desc,
        css_selector: selector, // empty string clears it server-side
        render_mode: renderMode,
      });
      closeModal();
      toast('Saved', 'success');
      Competitors.render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
      toast(e.message, 'error');
    }
  },

  async check(id, btn) {
    btn.disabled = true;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Checking…`;
    try {
      await API.checkCompetitor(id);
      toast('Check complete. Refreshing…', 'info');
      setTimeout(() => Competitors.render(), 2500);
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Check`;
    }
  },

  async toggle(id, btn) {
    btn.disabled = true;
    try {
      await API.toggleCompetitor(id);
      Competitors.render();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
    }
  },

  async remove(id, name) {
    openModal(`
      <div class="modal-header">
        <div class="modal-title">Delete Competitor</div>
        <button class="modal-close" onclick="closeModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p style="color:var(--txt-2);line-height:1.7">
          Are you sure you want to delete <strong style="color:var(--txt)">${esc(name)}</strong>?
          This will permanently remove all tracked changes and briefs for this competitor.
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="Competitors.confirmDelete(${id})">Delete Permanently</button>
      </div>
    `);
  },

  async confirmDelete(id) {
    try {
      await API.deleteCompetitor(id);
      closeModal();
      toast('Competitor deleted', 'success');
      Competitors.render();
      const stats = await API.getStats();
      App.stats = stats;
      App.updateBadges();
    } catch (e) {
      toast(e.message, 'error');
    }
  },
};
window.Competitors = Competitors;
