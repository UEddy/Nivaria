// Phase 9 — Deals & ROI page.
//
// One nav item, two tabs:
//   "Log & deals" — the fast inline logging form + the chronological deal list
//   "ROI dashboard" — detected win/loss correlations and revenue at risk
//
// Logging speed is the make-or-break constraint, so the form is inline (never a
// modal), 3 primary fields, autocompleted, keyboard-friendly, save on the right.

const Deals = {
  _tab: 'log',
  _competitors: [],

  // ── Money / format helpers ────────────────────────────────────────────────
  fmtMoney(n) {
    if (n === null || n === undefined || n === '') return null;
    return '$' + Number(n).toLocaleString('en-US');
  },
  fmtBig(n) {
    n = Number(n || 0);
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + n;
  },
  outcomePill(outcome) {
    const map = { won: 'deal-pill--won', lost: 'deal-pill--lost', stalled: 'deal-pill--stalled' };
    const label = { won: 'Won', lost: 'Lost', stalled: 'Stalled' }[outcome] || outcome;
    return `<span class="deal-pill ${map[outcome] || ''}">${label}</span>`;
  },
  confidencePill(conf) {
    const label = { low: 'Low', medium: 'Medium', high: 'High' }[conf] || conf;
    return `<span class="conf-pill conf-pill--${conf}">${label} confidence</span>`;
  },

  // ── Shell + tabs ────────────────────────────────────────────────────────────
  async render(routeQuery) {
    const tab = routeQuery && routeQuery.get ? routeQuery.get('tab') : null;
    Deals._tab = tab === 'roi' ? 'roi' : 'log';
    el('topbar-actions').innerHTML = '';

    try { Deals._competitors = await API.getCompetitors(); }
    catch { Deals._competitors = []; }

    Deals._drawShell();
    if (Deals._tab === 'roi') return Deals.loadRoi();
    return Deals.loadLog();
  },

  _drawShell() {
    el('page-root').innerHTML = `
      <div class="deals-tabs" role="tablist">
        <button class="deals-tab ${Deals._tab === 'log' ? 'active' : ''}" role="tab" onclick="Deals.switchTab('log')">Log &amp; deals</button>
        <button class="deals-tab ${Deals._tab === 'roi' ? 'active' : ''}" role="tab" onclick="Deals.switchTab('roi')">ROI dashboard</button>
      </div>
      <div id="deals-tab-content"><div class="loading-state"><div class="spinner"></div><span>Loading...</span></div></div>
    `;
  },

  switchTab(tab) {
    if (tab === Deals._tab) return;
    Deals._tab = tab;
    // Keep the URL honest without triggering a full re-route.
    history.replaceState(null, '', tab === 'roi' ? '#/deals?tab=roi' : '#/deals');
    document.querySelectorAll('.deals-tab').forEach((b, i) => b.classList.toggle('active', (i === 0) === (tab === 'log')));
    if (tab === 'roi') Deals.loadRoi(); else Deals.loadLog();
  },

  // ── LOG TAB ───────────────────────────────────────────────────────────────
  async loadLog() {
    const content = el('deals-tab-content');
    try {
      const { deals, total } = await API.getDeals({ limit: 200 });
      content.innerHTML = Deals.logHtml(deals, total);
      Deals._wireForm();
      window.staggerIn?.('.deal-row', 25, 40);
    } catch (e) {
      content.innerHTML = Deals._errorHtml(e.message);
    }
  },

  logHtml(deals, total) {
    const today = new Date().toISOString().slice(0, 10);
    const compOptions = Deals._competitors.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    const form = `
      <div class="log-card" id="log-card">
        <div class="log-card-head">
          <div>
            <div class="card-title">Log a deal outcome</div>
            <div class="card-sub">Takes about ten seconds. Outcome, name, and competitor are all you need.</div>
          </div>
          <button class="btn btn-primary btn-sm" id="log-toggle" onclick="Deals.toggleForm()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Log a deal
          </button>
        </div>

        <form class="log-form" id="log-form" style="display:none" onsubmit="event.preventDefault(); Deals.submitNew(this);">
          <div class="log-row">
            <div class="log-field log-field--outcome">
              <label class="form-label">Outcome</label>
              <div class="outcome-toggle" id="outcome-toggle">
                <button type="button" class="outcome-btn" data-outcome="won"     onclick="Deals.setOutcome('won', this)">Won</button>
                <button type="button" class="outcome-btn" data-outcome="lost"    onclick="Deals.setOutcome('lost', this)">Lost</button>
                <button type="button" class="outcome-btn" data-outcome="stalled" onclick="Deals.setOutcome('stalled', this)">Stalled</button>
              </div>
              <input type="hidden" id="deal-outcome" value="" />
            </div>

            <div class="log-field log-field--grow">
              <label class="form-label" for="deal-name">Deal name</label>
              <input class="form-input" id="deal-name" list="deal-name-list" autocomplete="off" placeholder="e.g. Acme Corp" maxlength="200" tabindex="1" />
              <datalist id="deal-name-list"></datalist>
            </div>

            <div class="log-field log-field--competitor" id="competitor-field" style="display:none">
              <label class="form-label" for="deal-competitor">Competitor</label>
              <select class="form-input" id="deal-competitor" tabindex="2">
                <option value="">Select competitor</option>
                ${compOptions}
              </select>
            </div>

            <div class="log-field log-field--value">
              <label class="form-label" for="deal-value">Value <span class="opt">(optional)</span></label>
              <input class="form-input" id="deal-value" type="number" inputmode="numeric" min="0" step="1000" placeholder="40000" tabindex="3" />
            </div>

            <div class="log-field log-field--date">
              <label class="form-label" for="deal-close-date">Close date</label>
              <input class="form-input" id="deal-close-date" type="date" value="${today}" tabindex="4" />
            </div>

            <div class="log-field log-field--save">
              <label class="form-label">&nbsp;</label>
              <button type="submit" class="btn btn-primary" id="deal-save" tabindex="6">Save deal</button>
            </div>
          </div>

          <div class="log-field log-field--notes">
            <input class="form-input" id="deal-notes" placeholder="Notes (optional)" maxlength="2000" tabindex="5"
              onfocus="this.classList.add('expanded')" />
          </div>
        </form>
      </div>
    `;

    const exportBtn = total > 0
      ? `<a class="btn btn-secondary btn-sm" href="/api/deals/export" download>
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
           Export CSV
         </a>`
      : '';

    const list = `
      <div class="card" style="margin-top:20px">
        <div class="card-header">
          <div>
            <div class="card-title">Logged deals</div>
            <div class="card-sub">${total} deal${total === 1 ? '' : 's'} logged</div>
          </div>
          ${exportBtn}
        </div>
        <div id="deal-list">${Deals.dealListHtml(deals)}</div>
      </div>
    `;

    return form + list;
  },

  dealListHtml(deals) {
    if (!deals || deals.length === 0) {
      return `
        <div class="empty-state" style="padding:32px 0">
          <div class="empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
          <div class="empty-title">No deals logged yet</div>
          <div class="empty-desc">Log your first win or loss above. Once you have a handful tagged to competitors, the ROI dashboard starts surfacing patterns.</div>
        </div>`;
    }
    return `
      <div class="deal-table">
        ${deals.map(d => `
          <div class="deal-row" onclick="navigate('/deals/${d.id}')">
            <div class="deal-row-outcome">${Deals.outcomePill(d.outcome)}</div>
            <div class="deal-row-main">
              <div class="deal-row-name">${esc(d.deal_name)}</div>
              <div class="deal-row-meta">
                ${d.competitor_name ? `<span>${esc(d.competitor_name)}</span><span class="feed-dot-sep">·</span>` : ''}
                <span>${formatShortDate(d.close_date)}</span>
                ${d.source === 'slack_command' ? '<span class="feed-dot-sep">·</span><span class="deal-src">via Slack</span>' : ''}
              </div>
            </div>
            <div class="deal-row-value">${d.deal_value_usd != null ? Deals.fmtMoney(d.deal_value_usd) : '<span class="text-muted">no value</span>'}</div>
            <div class="deal-row-actions" onclick="event.stopPropagation()">
              <button class="btn btn-ghost btn-sm" title="Edit" onclick="Deals.showEdit(${d.id})">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="btn btn-danger btn-sm" title="Delete" onclick="Deals.remove(${d.id}, '${esc(d.deal_name).replace(/'/g, "\\'")}')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </div>
          </div>
        `).join('')}
      </div>`;
  },

  // ── Form behavior ───────────────────────────────────────────────────────────
  _wireForm() {
    // Populate the autocomplete datalist from prior deal names.
    API.getDealNames('').then(({ names }) => {
      const dl = el('deal-name-list');
      if (dl) dl.innerHTML = (names || []).map(n => `<option value="${esc(n)}"></option>`).join('');
    }).catch(() => {});
  },

  toggleForm() {
    const form = el('log-form');
    if (!form) return;
    const showing = form.style.display !== 'none';
    form.style.display = showing ? 'none' : 'block';
    if (!showing) setTimeout(() => el('deal-name')?.focus(), 30);
  },

  setOutcome(outcome, btn) {
    el('deal-outcome').value = outcome;
    document.querySelectorAll('#outcome-toggle .outcome-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.classList.toggle(`active--${outcome}`, b === btn);
    });
    // Competitor is required for lost/stalled, hidden for won.
    const field = el('competitor-field');
    if (field) field.style.display = (outcome === 'lost' || outcome === 'stalled') ? '' : 'none';
  },

  async submitNew(formEl) {
    const outcome = el('deal-outcome').value;
    const dealName = el('deal-name').value.trim();
    const competitorId = el('deal-competitor').value;
    const value = el('deal-value').value;
    const closeDate = el('deal-close-date').value;
    const notes = el('deal-notes').value.trim();

    if (!outcome) { toast('Pick an outcome first', 'error'); return; }
    if (!dealName) { toast('Deal name is required', 'error'); el('deal-name').focus(); return; }
    if ((outcome === 'lost' || outcome === 'stalled') && !competitorId) {
      toast('A competitor is required for lost and stalled deals', 'error'); return;
    }

    const btn = el('deal-save');
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      await API.createDeal({
        deal_name: dealName,
        outcome,
        competitor_id: competitorId || null,
        deal_value_usd: value === '' ? null : Number(value),
        close_date: closeDate,
        notes: notes || null,
      });
      toast('Deal logged', 'success');
      // Reset fields, keep the form open for rapid entry.
      el('deal-outcome').value = '';
      document.querySelectorAll('#outcome-toggle .outcome-btn').forEach(b => { b.className = 'outcome-btn'; });
      el('competitor-field').style.display = 'none';
      formEl.reset();
      el('deal-close-date').value = new Date().toISOString().slice(0, 10);
      el('deal-name').focus();
      await Deals.refreshList();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Save deal';
    }
  },

  async refreshList() {
    try {
      const { deals, total } = await API.getDeals({ limit: 200 });
      const container = el('deal-list');
      if (container) container.innerHTML = Deals.dealListHtml(deals);
      const sub = document.querySelector('#deal-list')?.closest('.card')?.querySelector('.card-sub');
      if (sub) sub.textContent = `${total} deal${total === 1 ? '' : 's'} logged`;
      // Refresh the autocomplete datalist with any newly used name.
      Deals._wireForm();
    } catch (_) {}
  },

  // ── Edit / delete ───────────────────────────────────────────────────────────
  async showEdit(id) {
    let data;
    try { data = await API.getDeal(id); }
    catch (e) { toast(e.message, 'error'); return; }
    const d = data.deal;
    const compOptions = Deals._competitors.map(c =>
      `<option value="${c.id}" ${c.id === d.competitor_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

    openModal(`
      <div class="modal-header">
        <div class="modal-title">Edit deal</div>
        <button class="modal-close" onclick="closeModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Outcome</label>
          <select class="form-input" id="edit-outcome" onchange="Deals._editOutcomeChange()">
            <option value="won"     ${d.outcome === 'won' ? 'selected' : ''}>Won</option>
            <option value="lost"    ${d.outcome === 'lost' ? 'selected' : ''}>Lost</option>
            <option value="stalled" ${d.outcome === 'stalled' ? 'selected' : ''}>Stalled</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Deal name</label>
          <input class="form-input" id="edit-name" value="${esc(d.deal_name)}" maxlength="200" />
        </div>
        <div class="form-group" id="edit-competitor-group" style="${d.outcome === 'won' ? 'display:none' : ''}">
          <label class="form-label">Competitor</label>
          <select class="form-input" id="edit-competitor"><option value="">Select competitor</option>${compOptions}</select>
        </div>
        <div class="set-row-2">
          <div class="form-group">
            <label class="form-label">Value (optional)</label>
            <input class="form-input" id="edit-value" type="number" inputmode="numeric" min="0" step="1000" value="${d.deal_value_usd ?? ''}" />
          </div>
          <div class="form-group">
            <label class="form-label">Close date</label>
            <input class="form-input" id="edit-close-date" type="date" value="${esc(d.close_date)}" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Notes (optional)</label>
          <textarea class="form-input form-textarea" id="edit-notes" rows="2" maxlength="2000">${esc(d.notes || '')}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="Deals.submitEdit(${id}, this)">Save changes</button>
      </div>
    `);
  },

  _editOutcomeChange() {
    const outcome = el('edit-outcome').value;
    el('edit-competitor-group').style.display = (outcome === 'lost' || outcome === 'stalled') ? '' : 'none';
  },

  async submitEdit(id, btn) {
    const outcome = el('edit-outcome').value;
    const competitorId = el('edit-competitor').value;
    if ((outcome === 'lost' || outcome === 'stalled') && !competitorId) {
      toast('A competitor is required for lost and stalled deals', 'error'); return;
    }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await API.updateDeal(id, {
        deal_name: el('edit-name').value.trim(),
        outcome,
        competitor_id: competitorId || null,
        deal_value_usd: el('edit-value').value === '' ? null : Number(el('edit-value').value),
        close_date: el('edit-close-date').value,
        notes: el('edit-notes').value.trim() || null,
      });
      closeModal();
      toast('Deal updated', 'success');
      // If we're on the detail view, re-render it; else refresh the list.
      if (window.location.hash.startsWith('#/deals/')) Deals.renderDetail(id);
      else Deals.refreshList();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Save changes';
      toast(e.message, 'error');
    }
  },

  remove(id, name) {
    openModal(`
      <div class="modal-header">
        <div class="modal-title">Delete deal</div>
        <button class="modal-close" onclick="closeModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <p style="color:var(--txt-2);line-height:1.7">Delete <strong style="color:var(--txt)">${esc(name)}</strong>? This removes it from your win/loss history and any patterns it supports.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="Deals.confirmRemove(${id})">Delete</button>
      </div>
    `);
  },

  async confirmRemove(id) {
    try {
      await API.deleteDeal(id);
      closeModal();
      toast('Deal deleted', 'success');
      if (window.location.hash.startsWith('#/deals/')) navigate('/deals');
      else Deals.refreshList();
    } catch (e) { toast(e.message, 'error'); }
  },

  // ── DETAIL VIEW ───────────────────────────────────────────────────────────
  async renderDetail(id) {
    el('topbar-actions').innerHTML = `<a class="btn btn-ghost btn-sm" href="#/deals">← Back to deals</a>`;
    try {
      Deals._competitors = await API.getCompetitors().catch(() => []);
      const { deal, competitor_activity } = await API.getDeal(id);
      el('page-root').innerHTML = Deals.detailHtml(deal, competitor_activity);
      window.staggerIn?.('.activity-item', 60, 60);
    } catch (e) {
      el('page-root').innerHTML = Deals._errorHtml(e.message);
    }
  },

  detailHtml(d, activity) {
    const valStr = d.deal_value_usd != null ? Deals.fmtMoney(d.deal_value_usd) : 'Not recorded';
    const isLossy = d.outcome === 'lost' || d.outcome === 'stalled';

    const timeline = !isLossy
      ? `<div class="card-sub" style="padding:8px 0">Competitor activity context is shown for lost and stalled deals.</div>`
      : (!d.competitor_id
        ? `<div class="card-sub" style="padding:8px 0">No competitor tagged on this deal.</div>`
        : (activity.length === 0
          ? `<div class="empty-state" style="padding:28px 0">
               <div class="empty-title">No tracked changes in that window</div>
               <div class="empty-desc">${esc(d.competitor_name)} had no meaningful changes recorded in the 30 days before this deal closed. That absence is itself a useful data point.</div>
             </div>`
          : `<div class="activity-timeline">
              ${activity.map(a => `
                <div class="activity-item" onclick="navigate('/history/${a.id}')">
                  <div class="activity-pip ${a.threat_level}"></div>
                  <div class="activity-body">
                    <div class="activity-headline">${esc(a.headline || 'Change detected')}</div>
                    <div class="activity-meta">
                      <span>${formatShortDate(a.detected_at)}</span>
                      ${threatBadge(a.threat_level)}
                      ${(a.pattern_tags || []).map(t => `<span class="pattern-tag pattern-tag-sm">${esc(t.replace(/_/g, ' '))}</span>`).join('')}
                    </div>
                  </div>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--txt-3);flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
                </div>`).join('')}
             </div>`));

    return `
      <div class="deal-detail">
        <div class="card">
          <div class="deal-detail-head">
            <div>
              <div class="deal-detail-name">${esc(d.deal_name)}</div>
              <div class="deal-detail-sub">${Deals.outcomePill(d.outcome)} ${d.competitor_name ? `· vs ${esc(d.competitor_name)}` : ''}</div>
            </div>
            <div class="deal-detail-actions">
              <button class="btn btn-secondary btn-sm" onclick="Deals.showEdit(${d.id})">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="Deals.remove(${d.id}, '${esc(d.deal_name).replace(/'/g, "\\'")}')">Delete</button>
            </div>
          </div>
          <div class="deal-detail-grid">
            <div class="deal-stat"><div class="deal-stat-label">Value</div><div class="deal-stat-val">${valStr}</div></div>
            <div class="deal-stat"><div class="deal-stat-label">Close date</div><div class="deal-stat-val">${formatShortDate(d.close_date)}</div></div>
            <div class="deal-stat"><div class="deal-stat-label">Source</div><div class="deal-stat-val">${d.source === 'slack_command' ? 'Slack' : d.source === 'api' ? 'API' : 'Manual'}</div></div>
          </div>
          ${d.notes ? `<div class="deal-detail-notes"><div class="deal-stat-label">Notes</div><p>${esc(d.notes)}</p></div>` : ''}
        </div>

        <div class="card" style="margin-top:20px">
          <div class="card-header">
            <div>
              <div class="card-title">Competitor activity in the 30 days before this deal closed</div>
              <div class="card-sub">What ${esc(d.competitor_name || 'the competitor')} was doing while this deal was in play.</div>
            </div>
          </div>
          ${timeline}
        </div>
      </div>
    `;
  },

  // ── ROI TAB ───────────────────────────────────────────────────────────────
  async loadRoi() {
    const content = el('deals-tab-content');
    try {
      const roi = await API.getRoi();
      content.innerHTML = Deals.roiHtml(roi);
      window.staggerIn?.('.pattern-card', 80, 70);
    } catch (e) {
      content.innerHTML = Deals._errorHtml(e.message);
    }
  },

  roiHtml(roi) {
    if (roi.status === 'empty') {
      return `
        <div class="roi-primer">
          <div class="roi-primer-icon">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>
          </div>
          <div class="roi-primer-title">Quantify what competitors cost you</div>
          <div class="roi-primer-desc">
            Log your win/loss outcomes and tag the competitor on each loss. Foresight lines those losses up against what each competitor changed in the 30 days before the deal closed, then surfaces the patterns: "you lost N deals against X within 30 days of their pricing changes." It turns tracked activity into estimated revenue impact.
          </div>
          <button class="btn btn-primary" onclick="Deals.switchTab('log'); setTimeout(()=>Deals.toggleForm(), 60)">Log your first deal</button>
        </div>`;
    }

    if (roi.status === 'insufficient') {
      const more = Math.max(0, 5 - roi.total_deals);
      return `
        <div class="roi-progress">
          <div class="roi-progress-ring">${roi.total_deals}</div>
          <div class="roi-progress-title">${roi.total_deals} deal${roi.total_deals === 1 ? '' : 's'} logged</div>
          <div class="roi-progress-desc">
            ${more > 0
              ? `Log ${more} more deal${more === 1 ? '' : 's'} (with at least 3 losses tagged to competitors) and Foresight will start surfacing correlations. Patterns get reliable around 15 logged deals.`
              : `You have enough deals, but need at least 3 losses tagged to a competitor before patterns can form. Tag the competitor on your losses to unlock the dashboard.`}
          </div>
          <div class="roi-banner">
            Not enough data yet for reliable patterns. Keep logging deals. Patterns start emerging at 15+ logged deals.
          </div>
          <button class="btn btn-primary btn-sm" onclick="Deals.switchTab('log')">Log more deals</button>
        </div>`;
    }

    // status === 'ok'
    const rangeStr = roi.date_range.from
      ? `${formatShortDate(roi.date_range.from)} to ${formatShortDate(roi.date_range.to)}`
      : 'your logged deals';
    const headline = `
      <div class="roi-headline">
        <div class="roi-headline-label">Estimated revenue at risk from tracked competitors</div>
        <div class="roi-headline-value">${roi.revenue_at_risk_usd > 0 ? Deals.fmtBig(roi.revenue_at_risk_usd) : '—'}</div>
        <div class="roi-headline-sub">
          ${roi.revenue_at_risk_usd > 0
            ? `Across ${roi.revenue_at_risk_deal_count} deal${roi.revenue_at_risk_deal_count === 1 ? '' : 's'} in medium and high confidence patterns · based on ${roi.total_deals} logged deals over ${rangeStr}`
            : `Based on ${roi.total_deals} logged deals over ${rangeStr}. No medium or high confidence patterns carry a recorded value yet.`}
        </div>
        <div class="roi-headline-note">Correlation, not causation. These figures reflect deals that closed near competitor activity, not proof the activity caused the outcome.</div>
      </div>`;

    const banner = roi.small_sample_banner
      ? `<div class="roi-banner">Not enough data yet for reliable patterns. Keep logging deals. Patterns start emerging at 15+ logged deals.</div>`
      : '';

    const patterns = roi.patterns.length === 0
      ? `<div class="empty-state" style="padding:36px 0">
           <div class="empty-title">No patterns detected yet</div>
           <div class="empty-desc">You have enough deals logged, but no competitor's activity lines up with 3 or more of your losses yet. Keep logging, and tag competitors on every loss.</div>
         </div>`
      : roi.patterns.map(p => Deals.patternCardHtml(p)).join('');

    return headline + banner + `<div class="pattern-list">${patterns}</div>`;
  },

  patternCardHtml(p) {
    const impact = p.estimated_impact_usd != null ? Deals.fmtMoney(p.estimated_impact_usd) : 'No value recorded';
    const lowClass = p.confidence === 'low' ? 'pattern-card--low' : '';
    const dealsList = p.supporting_deals.map(d => `
      <div class="support-row">
        ${Deals.outcomePill(d.outcome)}
        <span class="support-name">${esc(d.deal_name)}</span>
        <span class="support-meta">${formatShortDate(d.close_date)}</span>
        <span class="support-val">${d.deal_value_usd != null ? Deals.fmtMoney(d.deal_value_usd) : '—'}</span>
      </div>`).join('');
    const changesList = p.supporting_changes.map(c => `
      <div class="support-row support-row--change" onclick="navigate('/history/${c.id}')">
        ${threatBadge(c.threat_level)}
        <span class="support-name">${esc(c.headline || 'Change')}</span>
        <span class="support-meta">${formatShortDate(c.detected_at)}</span>
      </div>`).join('');

    return `
      <div class="pattern-card ${lowClass}">
        <div class="pattern-card-head">
          ${Deals.confidencePill(p.confidence)}
          <div class="pattern-impact">
            <span class="pattern-impact-label">Est. revenue impact</span>
            <span class="pattern-impact-val">${impact}</span>
          </div>
        </div>
        <p class="pattern-desc">${esc(p.pattern_description)}</p>
        <div class="pattern-card-foot">
          <button class="btn btn-ghost btn-sm" onclick="Deals.toggleSupport(this)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="support-chev"><polyline points="6 9 12 15 18 9"/></svg>
            ${p.supporting_deals.length} supporting deal${p.supporting_deals.length === 1 ? '' : 's'}
          </button>
          <button class="btn ${p.alert_active ? 'btn-secondary' : 'btn-primary'} btn-sm" id="alert-btn-${p.competitor_id}-${p.type_key}"
            onclick="Deals.toggleAlert('${p.competitor_id}', '${p.pattern_type}', ${p.alert_active}, this)">
            ${p.alert_active ? '✓ Alert on' : 'Set up alert'}
          </button>
        </div>
        <div class="pattern-support" style="display:none">
          <div class="support-group-label">Deals in this pattern</div>
          ${dealsList}
          <div class="support-group-label" style="margin-top:12px">Competitor changes in the windows</div>
          ${changesList || '<div class="text-muted text-sm">No changes recorded.</div>'}
        </div>
      </div>`;
  },

  toggleSupport(btn) {
    const card = btn.closest('.pattern-card');
    const panel = card.querySelector('.pattern-support');
    const chev = btn.querySelector('.support-chev');
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
    if (chev) chev.style.transform = showing ? '' : 'rotate(180deg)';
  },

  async toggleAlert(competitorId, patternType, active, btn) {
    btn.disabled = true;
    try {
      if (active) {
        await API.removePatternAlert(Number(competitorId), patternType);
        btn.className = 'btn btn-primary btn-sm';
        btn.textContent = 'Set up alert';
        btn.setAttribute('onclick', `Deals.toggleAlert('${competitorId}', '${patternType}', false, this)`);
        toast('Alert removed', 'info');
      } else {
        await API.createPatternAlert(Number(competitorId), patternType);
        btn.className = 'btn btn-secondary btn-sm';
        btn.textContent = '✓ Alert on';
        btn.setAttribute('onclick', `Deals.toggleAlert('${competitorId}', '${patternType}', true, this)`);
        toast('Alert set. You will get a webhook when this competitor repeats this move.', 'success');
      }
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; }
  },

  _errorHtml(msg) {
    return `
      <div class="empty-state">
        <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
        <div class="empty-title">Could not load</div>
        <div class="empty-desc">${esc(msg)}</div>
      </div>`;
  },
};
window.Deals = Deals;
