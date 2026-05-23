const Settings = {
  async render() {
    try {
      const [{ settings, user }, ctxData, calData] = await Promise.all([
        API.getSettings(),
        API.getUserContext().catch(() => null), // never block settings on context fetch
        API.getCalendarConnections().catch(() => ({ encryption_configured: false, connections: [] })),
      ]);
      el('page-root').innerHTML = Settings.html(settings || {}, user, ctxData, calData);
      Settings.handleCalendarReturnParams();
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Error loading settings</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
    }
  },

  html(s, user, ctxData, calData) {
    const tier = user?.tier || 'free';
    const isProPlus = tier === 'pro' || tier === 'team';
    const tierLabel = { free: 'Free', pro: 'Pro', team: 'Team' }[tier] || tier;
    const limits = { free: '1', pro: '10', team: '∞' };
    const c = ctxData?.context || {};

    return `
      <div class="settings-grid">

        <!-- Business context (Phase 6) -->
        <div class="card">
          <div class="card-header" style="margin-bottom:16px">
            <div>
              <div class="card-title">Business context</div>
              <div class="card-sub">Fed into every AI battle card so analyses reflect your ICP, positioning, and deal size. Updates apply to future analyses only — past battle cards are not regenerated.</div>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:14px">
            <div class="form-group">
              <label class="form-label">Company name</label>
              <input class="form-input" id="ctx-company-name" maxlength="200"
                placeholder="What's your company called?" value="${esc(c.company_name || '')}" />
            </div>

            <div class="form-group">
              <label class="form-label">What we sell</label>
              <textarea class="form-input form-textarea" id="ctx-what-we-sell" rows="3" maxlength="5000"
                placeholder="Describe your product in 1–3 sentences.">${esc(c.what_we_sell || '')}</textarea>
            </div>

            <div class="form-group">
              <label class="form-label">Target ICP</label>
              <textarea class="form-input form-textarea" id="ctx-target-icp" rows="3" maxlength="5000"
                placeholder="Who do you sell to? Industry, company size, and the typical role you sell to.">${esc(c.target_icp || '')}</textarea>
            </div>

            <div class="form-group">
              <label class="form-label">Our positioning</label>
              <textarea class="form-input form-textarea" id="ctx-our-positioning" rows="3" maxlength="5000"
                placeholder="How do you differentiate from competitors?">${esc(c.our_positioning || '')}</textarea>
            </div>

            <div class="form-row two-col">
              <div class="form-group">
                <label class="form-label">Typical deal size</label>
                <select class="form-input" id="ctx-deal-size">
                  <option value=""           ${!c.typical_deal_size ? 'selected' : ''}>— Select —</option>
                  <option value="small"      ${c.typical_deal_size === 'small' ? 'selected' : ''}>Small ($5K–25K ACV)</option>
                  <option value="mid"        ${c.typical_deal_size === 'mid' ? 'selected' : ''}>Mid-market ($25K–100K ACV)</option>
                  <option value="large"      ${c.typical_deal_size === 'large' ? 'selected' : ''}>Large ($100K+ ACV)</option>
                  <option value="enterprise" ${c.typical_deal_size === 'enterprise' ? 'selected' : ''}>Enterprise ($250K+ ACV)</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Sales motion</label>
                <select class="form-input" id="ctx-sales-motion">
                  <option value=""       ${!c.sales_motion ? 'selected' : ''}>— Select —</option>
                  <option value="plg"    ${c.sales_motion === 'plg' ? 'selected' : ''}>PLG (product-led / self-serve)</option>
                  <option value="slg"    ${c.sales_motion === 'slg' ? 'selected' : ''}>SLG (sales-led)</option>
                  <option value="hybrid" ${c.sales_motion === 'hybrid' ? 'selected' : ''}>Hybrid (PLG + SLG)</option>
                </select>
              </div>
            </div>

            <div style="display:flex;justify-content:flex-end">
              <button class="btn btn-primary btn-sm" onclick="Settings.saveContext(this)">Save business context</button>
            </div>
          </div>
        </div>

        <!-- Account Info -->
        <div class="card">
          <div class="card-header" style="margin-bottom:16px">
            <div class="card-title">Account</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px">
            <div class="form-group">
              <label class="form-label">Name</label>
              <div class="form-input form-input--static">${esc(user?.name || '—')}</div>
            </div>
            <div class="form-group">
              <label class="form-label">Email</label>
              <div class="form-input form-input--static">${esc(user?.email || '—')}</div>
            </div>
            <div class="form-group">
              <label class="form-label">Current Plan</label>
              <div class="plan-display">
                <span class="plan-badge plan-badge--${tier}">${tierLabel}</span>
                <span class="text-muted text-sm">${limits[tier]} competitor URL${tier !== 'team' && tier !== 'free' ? 's' : tier === 'team' ? 's' : ''}</span>
                <a href="#/pricing" class="btn btn-ghost btn-sm" style="margin-left:auto">Change Plan</a>
              </div>
            </div>
          </div>
        </div>

        <!-- API Key -->
        <div class="card">
          <div class="card-header" style="margin-bottom:16px">
            <div class="card-title">API Access</div>
          </div>
          <div class="form-group">
            <label class="form-label">Your API Key</label>
            <div class="api-key-row">
              <div class="api-key-value" id="api-key-display" data-full="${esc(user?.api_key || '')}">
                ${esc(user?.api_key?.substring(0, 8))}••••••••••••••••••••
              </div>
              <button class="btn btn-secondary btn-sm" onclick="Settings.toggleApiKey()">Show</button>
              <button class="btn btn-ghost btn-sm" onclick="Settings.copyApiKey('${esc(user?.api_key || '')}')">Copy</button>
            </div>
            <span class="form-hint">Include as <code class="code-inline">X-Api-Key</code> header in API requests.</span>
          </div>
        </div>

        <!-- Slack -->
        <div class="card ${!isProPlus ? 'card--locked' : ''}">
          <div class="card-header" style="margin-bottom:14px">
            <div style="display:flex;align-items:center;gap:10px">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z"/><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z"/><path d="M14 14.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z"/><path d="M15.5 19H14v1.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5z"/><path d="M10 9.5C10 8.67 9.33 8 8.5 8h-5C2.67 8 2 8.67 2 9.5S2.67 11 3.5 11h5c.83 0 1.5-.67 1.5-1.5z"/><path d="M8.5 5H10V3.5C10 2.67 9.33 2 8.5 2S7 2.67 7 3.5 7.67 5 8.5 5z"/></svg>
              <div class="card-title">Slack Notifications</div>
            </div>
            ${!isProPlus ? `<span class="tier-badge">Pro+</span>` : ''}
          </div>
          ${!isProPlus ? `<p class="text-muted text-sm" style="margin-bottom:14px">Upgrade to Pro to receive Slack alerts when changes are detected.</p>` : ''}
          <div class="form-group">
            <label class="form-label">Incoming Webhook URL</label>
            <div class="webhook-row">
              <input class="form-input" id="slack-url" type="url" placeholder="https://hooks.slack.com/services/…"
                value="${esc(s.slack_webhook || '')}" ${!isProPlus ? 'disabled' : ''} />
              <button class="btn btn-secondary btn-sm" onclick="Settings.testWebhook('slack')" ${!isProPlus ? 'disabled' : ''}>Test</button>
            </div>
            <span class="form-hint">Create one at api.slack.com/messaging/webhooks</span>
          </div>
        </div>

        <!-- Discord -->
        <div class="card">
          <div class="card-header" style="margin-bottom:14px">
            <div style="display:flex;align-items:center;gap:10px">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.04.032.055A19.9 19.9 0 0 0 5.9 21.066a.077.077 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.074.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
              <div class="card-title">Discord Notifications</div>
            </div>
            ${!isProPlus ? `<span class="tier-badge">Pro+</span>` : ''}
          </div>
          ${!isProPlus ? `<p class="text-muted text-sm" style="margin-bottom:14px">Upgrade to Pro to receive Discord alerts when changes are detected.</p>` : ''}
          <div class="form-group">
            <label class="form-label">Webhook URL</label>
            <div class="webhook-row">
              <input class="form-input" id="discord-url" type="url" placeholder="https://discord.com/api/webhooks/…"
                value="${esc(s.discord_webhook || '')}" ${!isProPlus ? 'disabled' : ''} />
              <button class="btn btn-secondary btn-sm" onclick="Settings.testWebhook('discord')" ${!isProPlus ? 'disabled' : ''}>Test</button>
            </div>
            <span class="form-hint">Add a webhook in Discord: Channel Settings → Integrations</span>
          </div>
        </div>

        <!-- Calendar (Phase 7) -->
        ${Settings.calendarHtml(s, calData)}

        <!-- Save row -->
        <div class="settings-save-row">
          <button class="btn btn-primary" onclick="Settings.save()">Save Settings</button>
        </div>

      </div>

      <!-- Demo Controls -->
      <div class="card settings-danger-zone">
        <div class="card-header" style="margin-bottom:10px">
          <div class="card-title" style="color:var(--red)">Demo Controls</div>
        </div>
        <p class="text-muted text-sm" style="margin-bottom:14px">Switch your account tier to test how limits and features behave. In production this is handled by Stripe.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${['free', 'pro', 'team'].map(t => `
            <button class="btn ${user?.tier === t ? 'btn-secondary' : 'btn-ghost'} btn-sm"
              onclick="Settings.demoPlan('${t}')" ${user?.tier === t ? 'disabled' : ''}>
              ${user?.tier === t ? '✓ ' : ''}${t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  },

  toggleApiKey() {
    const display = document.getElementById('api-key-display');
    const btn = display.nextElementSibling;
    if (btn.textContent.trim() === 'Show') {
      display.textContent = display.dataset.full;
      btn.textContent = 'Hide';
    } else {
      display.textContent = display.dataset.full.substring(0, 8) + '••••••••••••••••••••';
      btn.textContent = 'Show';
    }
  },

  async copyApiKey(key) {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      toast('API key copied to clipboard', 'success');
    } catch { toast('Could not copy', 'error'); }
  },

  async testWebhook(type) {
    const url = document.getElementById(`${type}-url`)?.value.trim();
    if (!url) return toast('Enter a webhook URL first', 'error');

    const btn = document.querySelector(`button[onclick="Settings.testWebhook('${type}')"]`);
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
      await API.testWebhook(type, url);
      toast(`${type.charAt(0).toUpperCase() + type.slice(1)} test message sent!`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test';
    }
  },

  async save() {
    const slack = document.getElementById('slack-url')?.value.trim() || null;
    const discord = document.getElementById('discord-url')?.value.trim() || null;
    const briefingsEnabledEl = document.getElementById('briefings-enabled');
    const briefingsLeadEl    = document.getElementById('briefing-lead');
    const payload = { slack_webhook: slack, discord_webhook: discord };
    if (briefingsEnabledEl) payload.briefings_enabled = briefingsEnabledEl.checked ? 1 : 0;
    if (briefingsLeadEl)    payload.briefing_lead_minutes = parseInt(briefingsLeadEl.value, 10);

    try {
      await API.saveSettings(payload);
      toast('Settings saved', 'success');
    } catch (e) {
      if (e.upgrade_required) {
        toast(e.message, 'error');
        navigate('/pricing');
      } else {
        toast(e.message, 'error');
      }
    }
  },

  // ── Calendar / Phase 7 ──────────────────────────────────────────────────────

  calendarHtml(s, calData) {
    const conns = calData?.connections || [];
    const encryptionOk = !!calData?.encryption_configured;
    const google = conns.find(c => c.provider === 'google');
    const briefingsEnabled = (s?.briefings_enabled ?? 1) === 1;
    const briefingLead     = s?.briefing_lead_minutes ?? 30;

    return `
      <div class="card">
        <div class="card-header" style="margin-bottom:14px">
          <div>
            <div class="card-title">Calendar &amp; pre-meeting briefings</div>
            <div class="card-sub">Connect your calendar so Foresight pings your webhook with a battle card before any meeting that mentions a tracked competitor.</div>
          </div>
        </div>

        ${!encryptionOk ? `
          <div class="alert-banner" style="margin-bottom:14px">
            <div class="alert-banner-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </div>
            <div>
              <div class="alert-banner-title">CALENDAR_TOKEN_ENCRYPTION_KEY not set</div>
              <div class="alert-banner-sub">Server-side encryption key required before connecting a calendar — see README "Calendar setup".</div>
            </div>
          </div>` : ''}

        <div style="display:flex;flex-direction:column;gap:14px">
          ${google ? `
            <div class="form-group" style="border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;align-items:center;gap:14px">
              <div style="font-size:22px">📅</div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600">Google Calendar</div>
                <div class="text-muted text-sm">
                  ${esc(google.account_email || 'unknown account')}
                  · status <strong>${esc(google.status)}</strong>
                  ${google.last_synced_at ? `· last sync ${timeAgo(google.last_synced_at)}` : ''}
                </div>
                ${google.last_sync_error ? `<div class="text-sm" style="color:var(--red);margin-top:4px">${esc(google.last_sync_error)}</div>` : ''}
              </div>
              <button class="btn btn-ghost btn-sm" onclick="Settings.disconnectCalendar('google')">Disconnect</button>
            </div>
          ` : `
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <a class="btn btn-primary btn-sm" href="/api/calendar/google/connect" ${!encryptionOk ? 'aria-disabled="true" onclick="event.preventDefault(); toast(\'Set CALENDAR_TOKEN_ENCRYPTION_KEY first\', \'error\');"' : ''}>Connect Google Calendar</a>
              <button class="btn btn-secondary btn-sm" disabled title="Coming soon">Connect Microsoft 365 (coming soon)</button>
            </div>
          `}

          <div class="form-group">
            <label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="briefings-enabled" ${briefingsEnabled ? 'checked' : ''} />
              <span>Send pre-meeting briefings to my Slack/Discord webhook</span>
            </label>
          </div>

          <div class="form-group">
            <label class="form-label">Send briefings how long before the meeting?</label>
            <select id="briefing-lead" class="form-input" style="max-width:180px">
              <option value="15" ${briefingLead === 15 ? 'selected' : ''}>15 minutes before</option>
              <option value="30" ${briefingLead === 30 ? 'selected' : ''}>30 minutes before</option>
              <option value="60" ${briefingLead === 60 ? 'selected' : ''}>60 minutes before</option>
            </select>
          </div>
        </div>
      </div>
    `;
  },

  async disconnectCalendar(provider) {
    if (!confirm(`Disconnect ${provider === 'google' ? 'Google' : provider} Calendar? Pre-meeting briefings will stop until you reconnect.`)) return;
    try {
      await API.disconnectCalendar(provider);
      toast('Calendar disconnected', 'success');
      Settings.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  // Handle ?calendar_connected=google or ?calendar_error=... appended by the
  // OAuth callback when redirecting back to the SPA.
  handleCalendarReturnParams() {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx === -1) return;
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    if (params.has('calendar_connected')) {
      toast(`${params.get('calendar_connected')} calendar connected — initial sync running`, 'success');
    } else if (params.has('calendar_error')) {
      toast(`Calendar connect failed: ${params.get('calendar_error')}`, 'error');
    } else {
      return;
    }
    // Strip the query params from the hash so a refresh doesn't re-toast.
    history.replaceState(null, '', hash.slice(0, qIdx));
  },

  async saveContext(btn) {
    const payload = {
      company_name:      document.getElementById('ctx-company-name').value.trim(),
      what_we_sell:      document.getElementById('ctx-what-we-sell').value.trim(),
      target_icp:        document.getElementById('ctx-target-icp').value.trim(),
      our_positioning:   document.getElementById('ctx-our-positioning').value.trim(),
      typical_deal_size: document.getElementById('ctx-deal-size').value || null,
      sales_motion:      document.getElementById('ctx-sales-motion').value || null,
    };

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      await API.saveUserContext(payload);
      // The dashboard banner uses localStorage to gate visibility; a save
      // means the banner shouldn't reappear, so clear any prior dismissal.
      try { localStorage.removeItem('cs-ctx-banner-dismissed'); } catch (_) {}
      toast('Business context saved — applies to future analyses', 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  },

  async demoPlan(tier) {
    try {
      await API.setTier(tier);
      App.user.tier = tier;
      App.updateUserUI();
      toast(`Switched to ${tier} plan`, 'success');
      Settings.render();
    } catch (e) {
      toast(e.message, 'error');
    }
  },
};
window.Settings = Settings;
