const Settings = {
  async render() {
    try {
      const { settings, user } = await API.getSettings();
      el('page-root').innerHTML = Settings.html(settings || {}, user);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Error loading settings</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
    }
  },

  html(s, user) {
    const tier = user?.tier || 'free';
    const isProPlus = tier === 'pro' || tier === 'team';
    const tierLabel = { free: 'Free', pro: 'Pro', team: 'Team' }[tier] || tier;
    const limits = { free: '1', pro: '10', team: '∞' };

    return `
      <div class="settings-grid">

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

    try {
      await API.saveSettings({ slack_webhook: slack, discord_webhook: discord });
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
