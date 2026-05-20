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
          <div class="empty-desc">Add your first competitor URL to start monitoring for changes and generating battle cards.</div>
          <button class="btn btn-primary" onclick="Competitors.showAddModal()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add First Competitor
          </button>
        </div>
      `;
    }

    return `
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
                        ${esc(c.name)}
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
                <td class="text-muted text-sm">${c.last_checked ? timeAgo(c.last_checked) : '—'}</td>
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
                  ` : '<span class="text-muted">—</span>'}
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

      <p class="text-muted text-sm mt-16">
        ${App.user?.tier === 'free'
          ? `Free plan: 1 competitor. <a href="#/pricing" style="color:var(--accent-2)">Upgrade to Pro for 10</a> or <a href="#/pricing" style="color:var(--accent-2)">Team for unlimited</a>.`
          : App.user?.tier === 'pro'
          ? `Pro plan: up to 10 competitors. <a href="#/pricing" style="color:var(--accent-2)">Upgrade to Team for unlimited</a>.`
          : 'Team plan: unlimited competitors.'
        }
      </p>
    `;
  },

  statusPill(c) {
    if (!c.active) {
      return `<span class="status-pill status-pill--paused"><span class="status-dot"></span>Paused</span>`;
    }
    const s = c.last_check_status || '';
    const tip = c.last_check_error ? ` title="${esc(c.last_check_error)}"` : '';
    if (s === 'blocked') {
      return `<span class="status-pill status-pill--blocked"${tip}><span class="status-dot"></span>Blocked</span>`;
    }
    if (s === 'empty_content') {
      return `<span class="status-pill status-pill--empty"${tip}><span class="status-dot"></span>Empty</span>`;
    }
    if (s === 'selector_not_found') {
      const sel = c.css_selector ? ` (${esc(c.css_selector)})` : '';
      const fullTip = ` title="Selector not found${sel}. The page structure may have changed."`;
      return `<span class="status-pill status-pill--selector-missing"${fullTip}><span class="status-dot"></span>Selector not found</span>`;
    }
    if (s.startsWith('fetch_failed')) {
      return `<span class="status-pill status-pill--fetch-error"${tip}><span class="status-dot"></span>Fetch error</span>`;
    }
    if (s.startsWith('ok_')) {
      // Successful fetch but AI analysis fell back (ok_ai_out_of_credits, ok_no_ai_key, etc.)
      return `<span class="status-pill status-pill--ai-down"${tip}><span class="status-dot"></span>AI down</span>`;
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
          <input class="form-input" id="comp-url" placeholder="https://acmecorp.com/pricing" type="url" />
          <span class="form-hint">Monitor a specific page. Pricing, features, or homepage works best.</span>
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

  async submitAdd(btn) {
    const name     = el('comp-name').value.trim();
    const url      = el('comp-url').value.trim();
    const desc     = el('comp-desc').value.trim();
    const selector = el('comp-selector')?.value.trim() || '';

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
      });
      closeModal();
      toast(`${name} added successfully`, 'success');
      Competitors.render();
      const stats = await API.getStats();
      App.stats = stats;
      App.updateBadges();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Add Competitor';
      if (e.upgrade_required) {
        closeModal();
        toast(e.message, 'error');
        navigate('/pricing');
      } else {
        toast(e.message, 'error');
      }
    }
  },

  async showEditModal(id) {
    let c;
    try {
      const all = await API.getCompetitors();
      c = all.find(x => x.id === id);
    } catch (e) { toast(e.message, 'error'); return; }
    if (!c) { toast('Competitor not found', 'error'); return; }

    openModal(`
      <div class="modal-header">
        <div class="modal-title">Edit Competitor</div>
        <button class="modal-close" onclick="closeModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Competitor Name <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="edit-comp-name" value="${esc(c.name)}" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">Page URL to Monitor <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="edit-comp-url" value="${esc(c.url)}" type="url" />
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
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="Competitors.submitEdit(${id}, this)">Save Changes</button>
      </div>
    `);
    setTimeout(() => el('edit-comp-name').focus(), 50);
  },

  async submitEdit(id, btn) {
    const name     = el('edit-comp-name').value.trim();
    const url      = el('edit-comp-url').value.trim();
    const desc     = el('edit-comp-desc').value.trim();
    const selector = el('edit-comp-selector').value.trim();

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
          This will permanently remove all tracked changes and battle cards for this competitor.
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
