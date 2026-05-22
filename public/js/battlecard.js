const BattleCard = {
  async render(id) {
    el('topbar-actions').innerHTML = `
      <a href="#/history" class="btn btn-ghost btn-sm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Feed
      </a>`;

    try {
      const c = await API.getChange(id);
      el('page-root').innerHTML = BattleCard.html(c);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Battle card not found</div>
          <div class="empty-desc">${esc(e.message)}</div>
          <a href="#/history" class="btn btn-secondary">← Back to Feed</a>
        </div>`;
    }
  },

  html(c) {
    const a = c.analysis || {};
    const talkingPoints = Array.isArray(c.talking_points) ? c.talking_points : (a.talking_points || []);
    const keyChanges = Array.isArray(a.key_changes) ? a.key_changes : [];
    const threat = c.threat_level || 'low';
    // Phase 6: "Analyzed for: [Company]" label shown only when the AI actually
    // saw the user's business context (context_used flag set at insert time)
    // AND a company name is on file. If either is missing, render generic.
    const analyzedFor = (c.context_used === 1 && c.user_company_name && c.user_company_name.trim())
      ? c.user_company_name.trim()
      : null;
    // Phase 5: historical context + recent prior changes for this competitor.
    // historical_context lives either on the change row directly (post-Phase 5)
    // or, for older Phase-4 rows, never — guard for both.
    const historicalContext = (typeof c.historical_context === 'string' && c.historical_context.trim())
      ? c.historical_context.trim()
      : (typeof a.historical_context === 'string' ? a.historical_context.trim() : '');
    const patternTags = Array.isArray(c.pattern_tags) ? c.pattern_tags
                       : (Array.isArray(a.pattern_tags) ? a.pattern_tags : []);
    const recentChanges = Array.isArray(c.recent_changes) ? c.recent_changes : [];

    const threatMeta = {
      high:   { color: 'var(--red)',    label: 'HIGH THREAT',   bg: 'var(--red-dim)',    border: 'rgba(239,68,68,0.25)' },
      medium: { color: 'var(--yellow)', label: 'MEDIUM THREAT', bg: 'var(--yellow-dim)', border: 'rgba(245,158,11,0.2)' },
      low:    { color: 'var(--green)',  label: 'LOW THREAT',    bg: 'var(--green-dim)',  border: 'rgba(16,185,129,0.2)' },
    };
    const tm = threatMeta[threat] || threatMeta.low;

    return `
      <div class="bc-wrap">

        ${analyzedFor ? `
          <div class="bc-analyzed-for" title="This battle card was personalized using your saved business context. Edit in Settings.">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            Analyzed for: ${esc(analyzedFor)}
          </div>
        ` : ''}

        <!-- Header -->
        <div class="bc-header">
          <div class="bc-left">
            ${avatarHtml(c.competitor_name, 52)}
            <div>
              <div class="bc-comp-name">${esc(c.competitor_name)}</div>
              <a href="${esc(c.competitor_url)}" target="_blank" class="bc-comp-url">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                ${esc(c.competitor_url.replace(/^https?:\/\//, '').substring(0, 50))}
              </a>
            </div>
          </div>
          <div class="bc-threat" style="background:${tm.bg};border-color:${tm.border};color:${tm.color}">
            <div class="bc-threat-label">${tm.label}</div>
            <div class="bc-threat-date">${formatDate(c.detected_at)}</div>
          </div>
        </div>

        <!-- Headline -->
        <div class="bc-headline-wrap">
          <h2 class="bc-headline">${esc(c.headline || 'Change detected')}</h2>
          <div class="bc-headline-actions">
            ${threatBadge(threat)}
            <button class="btn btn-ghost btn-sm" onclick="BattleCard.copy(${c.id})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy Battle Card
            </button>
          </div>
        </div>

        <!-- Summary -->
        ${a.summary ? `
          <div class="bc-section bc-summary">
            <div class="bc-section-label">Executive Summary</div>
            <div class="bc-section-body">${esc(a.summary)}</div>
          </div>
        ` : ''}

        <!-- Pattern context (Phase 5) -->
        ${historicalContext ? `
          <div class="bc-section bc-pattern-context">
            <div class="bc-section-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 12 8 12 11 5 14 19 17 12 21 12"/></svg>
              Pattern context
            </div>
            <div class="bc-section-body">${esc(historicalContext)}</div>
            ${patternTags.length > 0 ? `
              <div class="bc-pattern-tags">
                ${patternTags.map(t => `<span class="pattern-tag">${esc(t.replace(/_/g, ' '))}</span>`).join('')}
              </div>` : ''}
          </div>
        ` : ''}

        <!-- Grid -->
        <div class="bc-grid">

          <!-- Recommended Response -->
          <div class="bc-section bc-response">
            <div class="bc-section-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Recommended Response
            </div>
            <div class="bc-section-body">${esc(a.recommended_response || c.recommended_response || 'Review changes manually.')}</div>
            ${a.threat_reasoning ? `
              <div class="bc-reasoning">
                <strong>Why this level:</strong> ${esc(a.threat_reasoning)}
              </div>` : ''}
          </div>

          <!-- Opportunity -->
          ${a.opportunity ? `
            <div class="bc-section bc-opportunity">
              <div class="bc-section-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                Opportunity
              </div>
              <div class="bc-section-body">${esc(a.opportunity)}</div>
            </div>
          ` : '<div></div>'}

          <!-- Talking Points -->
          <div class="bc-section bc-full">
            <div class="bc-section-header">
              <div class="bc-section-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Sales Talking Points
              </div>
              <button class="btn btn-ghost btn-sm" onclick="BattleCard.copyPoints(this)">Copy All</button>
            </div>
            ${talkingPoints.length > 0
              ? `<ul class="talking-points">
                  ${talkingPoints.map(p => `
                    <li class="talking-point">
                      <span class="talking-point-check">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      </span>
                      ${esc(p)}
                    </li>`).join('')}
                </ul>`
              : '<p class="text-muted text-sm">No talking points generated.</p>'
            }
          </div>

          <!-- Key Changes -->
          ${keyChanges.length > 0 ? `
            <div class="bc-section bc-full">
              <div class="bc-section-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                Key Changes Detected
              </div>
              <div class="key-changes">
                ${keyChanges.map(kc => `
                  <div class="key-change">
                    <span class="key-change-cat">${esc(kc.category || 'other')}</span>
                    <div class="key-change-body">
                      <div class="key-change-desc">${esc(kc.description || '')}</div>
                      ${kc.impact ? `<div class="key-change-impact">${esc(kc.impact)}</div>` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

        </div>

        <!-- Recent changes from this competitor (Phase 5) -->
        ${recentChanges.length > 0 ? `
          <div class="bc-section bc-recent">
            <div class="bc-section-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Recent changes from this competitor
            </div>
            <ul class="recent-changes-list">
              ${recentChanges.map(r => `
                <li class="recent-change-item" onclick="navigate('/history/${r.id}')">
                  <span class="recent-change-date">${esc(formatShortDate(r.detected_at))}</span>
                  ${threatBadge(r.threat_level)}
                  <span class="recent-change-headline">${esc(r.headline || 'Change detected')}</span>
                  ${(r.pattern_tags && r.pattern_tags.length) ? `<span class="recent-change-tags">${r.pattern_tags.slice(0, 2).map(t => `<span class="pattern-tag pattern-tag-sm">${esc(t.replace(/_/g, ' '))}</span>`).join('')}</span>` : ''}
                </li>
              `).join('')}
            </ul>
            <div class="recent-changes-footer">
              <a href="#/competitors/${c.competitor_id}" class="btn btn-ghost btn-sm">
                View full timeline
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
              </a>
            </div>
          </div>
        ` : ''}

        <!-- Footer -->
        <div class="bc-footer">
          <a href="#/history" class="btn btn-ghost btn-sm">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            All Changes
          </a>
          <a href="#/history?competitor_id=${c.competitor_id}" class="btn btn-ghost btn-sm">
            All ${esc(c.competitor_name)} Changes
          </a>
          <a href="${esc(c.competitor_url)}" target="_blank" class="btn btn-secondary btn-sm" style="margin-left:auto">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            View Live Page
          </a>
        </div>

      </div>
    `;
  },

  async copy(id) {
    try {
      const c = await API.getChange(id);
      const a = c.analysis || {};
      const points = Array.isArray(c.talking_points) ? c.talking_points : (a.talking_points || []);

      const text = [
        `BATTLE CARD: ${c.competitor_name}`,
        `Date: ${formatDate(c.detected_at)}`,
        `Threat Level: ${(c.threat_level || 'unknown').toUpperCase()}`,
        '',
        `HEADLINE: ${c.headline}`,
        '',
        `SUMMARY: ${a.summary || ''}`,
        '',
        `RECOMMENDED RESPONSE: ${a.recommended_response || c.recommended_response || ''}`,
        '',
        'TALKING POINTS:',
        ...points.map((p, i) => `${i + 1}. ${p}`),
        '',
        `OPPORTUNITY: ${a.opportunity || ''}`,
        '',
        `Source: Foresight | ${c.competitor_url}`,
      ].join('\n');

      await navigator.clipboard.writeText(text);
      toast('Battle card copied to clipboard', 'success');
    } catch (e) {
      toast('Could not copy: ' + e.message, 'error');
    }
  },

  async copyPoints(btn) {
    const pts = Array.from(document.querySelectorAll('.talking-point')).map(li => li.textContent.trim());
    if (pts.length === 0) return toast('No talking points to copy', 'error');
    try {
      await navigator.clipboard.writeText(pts.join('\n'));
      btn.textContent = '✓ Copied!';
      toast('Talking points copied', 'success');
      setTimeout(() => { btn.textContent = 'Copy All'; }, 2000);
    } catch (e) {
      toast('Could not copy', 'error');
    }
  },
};
window.BattleCard = BattleCard;
