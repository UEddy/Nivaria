// Settings — Pattern 2 sidebar layout. A left vertical nav switches between five
// independent section panels (no long-scroll single page). Sections:
//   workspace · integrations · notifications · billing · account
// Per-user identity (name, timezone, password, voice profile) lives on the
// separate Profile page (public/js/profile.js), NOT here.
//
// Each section is a real hash sub-route (#/settings/<section>) so deep links,
// browser back/forward, and the OAuth return redirects all work. The fetched
// data bundle is cached on Settings._ctx; tab switches re-render the active
// panel from cache (no skeleton flash), while a bare Settings.render() call
// (e.g. after a billing mutation) refetches fresh data and stays on the
// current section.

const Settings = {
  _ctx: null,            // cached { settings, user, ctxData, voiceData, calData, slackData, subData }
  _activeSection: 'workspace',

  SECTIONS: [
    { id: 'workspace',     label: 'Workspace',     icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/></svg>` },
    { id: 'integrations',  label: 'Integrations',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7H6a3 3 0 0 0 0 6h3"/><path d="M15 17h3a3 3 0 0 0 0-6h-3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>` },
    { id: 'notifications', label: 'Notifications',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>` },
    { id: 'billing',       label: 'Billing',        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>` },
    { id: 'account',       label: 'Account',        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>` },
  ],

  _RETURN_PARAMS: ['calendar_connected', 'calendar_error', 'slack_connected', 'slack_error'],

  // Resolve which section to show from an explicit id, then from any OAuth/upgrade
  // return params (so old #/settings?calendar_connected=… links land on Integrations),
  // then the last active section, then the workspace default.
  _resolveSection(section, routeQuery) {
    if (section) return section;
    if (routeQuery instanceof URLSearchParams) {
      if (Settings._RETURN_PARAMS.some(k => routeQuery.has(k))) return 'integrations';
      if (routeQuery.has('upgraded')) return 'billing';
    }
    return Settings._activeSection || 'workspace';
  },

  async render(routeQuery, section) {
    const fromRouter = arguments.length > 0; // bare Settings.render() == mutation re-render
    const target = Settings._resolveSection(section, routeQuery);
    Settings._activeSection = target;

    const hasReturnParams = routeQuery instanceof URLSearchParams &&
      Settings._RETURN_PARAMS.some(k => routeQuery.has(k));
    const shellExists = !!document.getElementById('settings-shell');
    // Refetch when: no cache, mutation re-render, OAuth return (state changed),
    // or we're (re)entering settings fresh (no shell mounted).
    const needFetch = !Settings._ctx || !fromRouter || hasReturnParams || !shellExists;

    if (needFetch) {
      try {
        const [{ settings, user }, ctxData, voiceData, calData, slackData, subData] = await Promise.all([
          API.getSettings(),
          API.getUserContext().catch(() => null),
          API.getVoiceProfile().catch(() => null),
          API.getCalendarConnections().catch(() => ({ encryption_configured: false, connections: [] })),
          API.getSlackConnection().catch(() => ({ oauth_configured: false, signing_configured: false, connected: false })),
          API.getSubscription().catch(() => null),
        ]);
        Settings._ctx = { settings: settings || {}, user, ctxData, voiceData, calData, slackData, subData };
      } catch (e) {
        el('page-root').innerHTML = `
          <div class="empty-state">
            <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
            <div class="empty-title">Error loading settings</div>
            <div class="empty-desc">${esc(e.message)}</div>
          </div>`;
        return;
      }
    }

    el('page-root').innerHTML = Settings.shellHtml(Settings._ctx, target);
    Settings._wireDirty();
    Settings.handleCalendarReturnParams(routeQuery);
    Settings.handleSlackReturnParams(routeQuery);
  },

  // Navigate to a section. Anchors already carry the href; this is the keyboard/
  // programmatic path and keeps the URL the single source of truth.
  go(section) { navigate('/settings/' + section); },

  // ── Shell: identity header + left nav + active panel ────────────────────────

  shellHtml(ctx, active) {
    const { user, subData } = ctx;
    const tier = (subData && subData.effectiveTier) || 'free';
    const tierLabel = { free: 'Free', pro: 'Pro', team: 'Team', business: 'Business' }[tier] || tier;
    const section = Settings.SECTIONS.find(x => x.id === active) || Settings.SECTIONS[0];

    const nav = Settings.SECTIONS.map(sx => {
      const on = sx.id === active;
      return `
        <a href="#/settings/${sx.id}" class="settings-nav__item ${on ? 'is-active' : ''}"
           data-section="${sx.id}" aria-current="${on ? 'page' : 'false'}">
          <span class="settings-nav__icon">${sx.icon}</span>
          <span class="settings-nav__label">${sx.label}</span>
        </a>`;
    }).join('');

    return `
      <div class="settings-page settings-page--split">
        <div class="settings-page-header">
          <div>
            <div class="settings-page-title">Settings</div>
            <div class="settings-page-subtitle">Manage your workspace context, integrations, and account.</div>
          </div>
          <div class="settings-identity">
            <span>${esc(user?.email || '')}</span>
            <span class="dot-sep">·</span>
            <span class="plan-badge plan-badge--${tier}">${tierLabel} Plan</span>
          </div>
        </div>
        <div class="settings-page-divider"></div>

        <div class="settings-shell" id="settings-shell">
          <nav class="settings-nav" aria-label="Settings sections">${nav}</nav>
          <div class="settings-panel" id="settings-panel" role="region" aria-label="${esc(section.label)} settings">
            <div class="settings-stack">${Settings.panelHtml(active, ctx)}</div>
          </div>
        </div>
      </div>`;
  },

  panelHtml(section, ctx) {
    const { settings: s, user, ctxData, calData, slackData, subData } = ctx;
    const tier = (subData && subData.effectiveTier) || 'free';
    const isProPlus = tier === 'pro' || tier === 'team' || tier === 'business';
    const c = ctxData?.context || {};

    switch (section) {
      case 'workspace':
        return Settings.businessContextHtml(c);
      case 'integrations':
        return Settings.calendarHtml(s, calData) + Settings.slackHtml(slackData) + Settings.webhooksHtml(s, isProPlus);
      case 'notifications':
        return Settings.notificationsHtml(s, user?.email);
      case 'billing':
        return Settings.billingHtml(subData);
      case 'account':
        return Settings.accountHtml(user) + Settings.gdprHtml();
      default:
        return Settings.businessContextHtml(c);
    }
  },

  // ── Plan & billing (Phase 10) ───────────────────────────────────────────────

  billingHtml(sub) {
    const tier   = (sub && sub.effectiveTier) || 'free';
    const status = sub && sub.status;
    const cancel = sub && sub.cancelAtPeriodEnd;
    const periodEnd = sub && sub.currentPeriodEnd;
    const fmt = (d) => (d ? formatShortDate(d) : '—');
    const badgeTier = tier === 'business' ? 'team' : tier; // reuse team gradient
    const badge = `<span class="plan-badge plan-badge--${badgeTier}">${tier.charAt(0).toUpperCase() + tier.slice(1)}</span>`;

    let body;
    if (tier === 'free') {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta">1 competitor · manual checks</span>
          <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="Billing.subscribe(this)">Upgrade to Pro ($20/mo)</button>
        </div>
        <span class="form-hint">Unlock 10 competitors, daily monitoring, alerts, calendar briefings, outreach playbooks, and win/loss correlation.</span>`;
    } else if (status === 'past_due') {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta" style="color:var(--red)">Payment failed. Update your card to keep Pro.</span>
          <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="Billing.openPortal(this)">Update payment</button>
        </div>`;
    } else if (cancel) {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta">Your Pro access ends ${fmt(periodEnd)}.</span>
          <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="Billing.resume(this)">Resume subscription</button>
        </div>
        <span class="form-hint">You keep Pro until then. Resume any time to stay subscribed.</span>`;
    } else if (status === 'paused') {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta">Subscription paused.</span>
          <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="Billing.openPortal(this)">Manage</button>
        </div>`;
    } else {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta">Next billing ${fmt(periodEnd)}.</span>
          <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="Billing.openPortal(this)">Manage subscription</button>
        </div>
        <div style="display:flex">
          <button class="set-linkbtn set-linkbtn--danger" onclick="Billing.confirmCancel()">Cancel subscription</button>
        </div>`;
    }

    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Plan &amp; billing</div>
          <div class="set-card__desc">Your current plan and subscription. Billing is handled securely by Lemon Squeezy.</div>
        </div>
        <div class="set-card__body">
          ${body}
          <div>
            <button class="set-linkbtn" style="padding-left:0" onclick="Billing.reconcile(this)">Subscription not showing correctly?</button>
          </div>
        </div>
      </div>`;
  },

  // ── Account — programmatic API access ────────────────────────────────────────
  // Name, email, password and voice live on the Profile page now. This card
  // keeps account-level programmatic access; the danger zone (export + delete)
  // follows it via gdprHtml().

  accountHtml(user) {
    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">API access</div>
          <div class="set-card__desc">Your programmatic API key. Manage your name, email, and password on your <a href="#/profile" class="link-accent">Profile</a>.</div>
        </div>
        <div class="set-card__body">
          <div class="form-group">
            <label class="form-label">API key</label>
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
      </div>`;
  },

  // ── Your data (Phase 10 GDPR) — danger zone ─────────────────────────────────

  gdprHtml() {
    return `
      <div class="set-card set-card--danger">
        <div class="set-card__head">
          <div class="set-card__title">Danger zone</div>
          <div class="set-card__desc">Export everything we hold about you, or permanently delete your account.</div>
        </div>
        <div class="set-card__body">
          <p class="set-plan-meta" style="margin-bottom:14px;line-height:1.55">
            Nivaria respects your data rights. You can export your data or delete your account at any time. See our <a href="/privacy" target="_blank" rel="noopener" class="link-accent">Privacy Policy</a> for details.
          </p>
          <div class="set-plan-row">
            <span class="set-plan-meta">Download a full JSON export of your workspace data.</span>
            <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="Billing.exportData(this)">Export my data</button>
          </div>
          <div class="set-plan-row">
            <span class="set-plan-meta">Permanently delete your account and all data. This is immediate and cannot be undone.</span>
            <button class="btn-delete-account" style="margin-left:auto" onclick="Billing.confirmDeleteAccount()">DELETE ACCOUNT</button>
          </div>
        </div>
      </div>`;
  },

  // ── Business context (Phase 6) — Workspace section ──────────────────────────

  businessContextHtml(c) {
    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Business context</div>
          <div class="set-card__desc">This data is fed into every brief so future analyses reflect your ICP, positioning, and deal size. Updates apply to future analyses only; past briefs will not be regenerated.</div>
        </div>
        <div class="set-card__body" data-dirty-group>
          <div class="form-group">
            <label class="form-label">Company name</label>
            <input class="form-input" id="ctx-company-name" maxlength="200"
              placeholder="What's your company called?" value="${esc(c.company_name || '')}" />
          </div>

          <div class="form-group">
            <label class="form-label">What we sell</label>
            <textarea class="form-input form-textarea" id="ctx-what-we-sell" rows="3" maxlength="5000"
              placeholder="Describe your product in 1 to 3 sentences.">${esc(c.what_we_sell || '')}</textarea>
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

          <div class="set-row-2">
            <div class="form-group">
              <label class="form-label">Typical deal size</label>
              <select class="form-input" id="ctx-deal-size">
                <option value=""           ${!c.typical_deal_size ? 'selected' : ''}>Select</option>
                <option value="small"      ${c.typical_deal_size === 'small' ? 'selected' : ''}>Small ($5K to $25K ACV)</option>
                <option value="mid"        ${c.typical_deal_size === 'mid' ? 'selected' : ''}>Mid-market ($25K to $100K ACV)</option>
                <option value="large"      ${c.typical_deal_size === 'large' ? 'selected' : ''}>Large ($100K+ ACV)</option>
                <option value="enterprise" ${c.typical_deal_size === 'enterprise' ? 'selected' : ''}>Enterprise ($250K+ ACV)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Sales motion</label>
              <select class="form-input" id="ctx-sales-motion">
                <option value=""       ${!c.sales_motion ? 'selected' : ''}>Select</option>
                <option value="plg"    ${c.sales_motion === 'plg' ? 'selected' : ''}>PLG (product-led / self-serve)</option>
                <option value="slg"    ${c.sales_motion === 'slg' ? 'selected' : ''}>SLG (sales-led)</option>
                <option value="hybrid" ${c.sales_motion === 'hybrid' ? 'selected' : ''}>Hybrid (PLG + SLG)</option>
              </select>
            </div>
          </div>

          <div class="set-card__footer">
            <button class="btn btn-primary btn-sm" data-save-btn onclick="Settings.saveContext(this)">Save changes</button>
          </div>
        </div>
      </div>
    `;
  },

  // ── Calendar (Phase 7) — Integrations section ───────────────────────────────

  calendarHtml(s, calData) {
    const conns = calData?.connections || [];
    const encryptionOk = !!calData?.encryption_configured;
    const google = conns.find(c => c.provider === 'google');

    const googleG = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 11v2.85h3.95c-.2 1.05-1.55 3.1-3.95 3.1-2.4 0-4.35-1.98-4.35-4.45S9.6 8.05 12 8.05c1.36 0 2.28.58 2.8 1.08l1.9-1.83C15.48 6.16 13.9 5.5 12 5.5a6.5 6.5 0 1 0 0 13c3.75 0 6.23-2.64 6.23-6.35 0-.43-.05-.75-.11-1.07L12 11Z"/></svg>`;

    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Calendar connection</div>
          <div class="set-card__desc">Connect a calendar so Nivaria can match upcoming meetings to tracked competitors. Briefing delivery preferences live in the Notifications section.</div>
        </div>
        <div class="set-card__body">

          ${!encryptionOk ? `
            <div class="alert-banner">
              <div class="alert-banner-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              </div>
              <div>
                <div class="alert-banner-title">CALENDAR_TOKEN_ENCRYPTION_KEY not set</div>
                <div class="alert-banner-sub">Server-side encryption key required before connecting a calendar. See README "Calendar setup".</div>
              </div>
            </div>` : ''}

          ${google ? `
            <div class="set-integration-block">
              <div class="set-integration">
                <div class="set-integration__icon">${googleG(18)}</div>
                <div class="set-integration__text">
                  <div class="set-integration__name">Google Calendar</div>
                  <div class="set-integration__meta">Connected as ${esc(google.account_email || 'unknown account')}${google.last_synced_at ? ` · last synced ${timeAgo(google.last_synced_at)}` : ''}</div>
                </div>
                <div class="set-integration__action">
                  <span class="set-pill set-pill--active">Active</span>
                  <button class="set-linkbtn set-linkbtn--danger" onclick="Settings.promptDisconnect('google', this)">Disconnect</button>
                </div>
              </div>
              ${google.last_sync_error ? `<div class="text-sm" style="color:var(--red)">${esc(google.last_sync_error)}</div>` : ''}
            </div>
          ` : `
            <div class="set-empty">
              <div class="set-empty__icon">${googleG(24)}</div>
              <div class="set-empty__title">No calendar connected</div>
              <div class="set-empty__desc">Connect Google Calendar to get briefings 30 minutes before competitor-relevant meetings.</div>
              <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
                <a class="btn btn-primary btn-sm" href="/api/calendar/google/connect" ${!encryptionOk ? 'aria-disabled="true" onclick="event.preventDefault(); toast(\'Set CALENDAR_TOKEN_ENCRYPTION_KEY first\', \'error\');"' : ''}>Connect Google Calendar</a>
                <button class="btn btn-secondary btn-sm" disabled title="Coming soon">Microsoft 365 <span class="tier-badge" style="margin-left:6px">Soon</span></button>
              </div>
            </div>
          `}
        </div>
      </div>
    `;
  },

  // ── Slack deal logging (Phase 9) — Integrations section ─────────────────────

  slackHtml(slackData) {
    const d = slackData || {};
    const slackIcon = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.04 15.16a2.52 2.52 0 0 1-2.52 2.52A2.52 2.52 0 0 1 0 15.16a2.52 2.52 0 0 1 2.52-2.52h2.52v2.52zm1.27 0a2.52 2.52 0 0 1 2.52-2.52 2.52 2.52 0 0 1 2.52 2.52v6.32A2.52 2.52 0 0 1 8.83 24a2.52 2.52 0 0 1-2.52-2.52v-6.32zM8.83 5.04a2.52 2.52 0 0 1-2.52-2.52A2.52 2.52 0 0 1 8.83 0a2.52 2.52 0 0 1 2.52 2.52v2.52H8.83zm0 1.27a2.52 2.52 0 0 1 2.52 2.52 2.52 2.52 0 0 1-2.52 2.52H2.52A2.52 2.52 0 0 1 0 8.83a2.52 2.52 0 0 1 2.52-2.52h6.32zM18.96 8.83a2.52 2.52 0 0 1 2.52-2.52A2.52 2.52 0 0 1 24 8.83a2.52 2.52 0 0 1-2.52 2.52h-2.52V8.83zm-1.27 0a2.52 2.52 0 0 1-2.52 2.52 2.52 2.52 0 0 1-2.52-2.52V2.52A2.52 2.52 0 0 1 15.17 0a2.52 2.52 0 0 1 2.52 2.52v6.32zM15.17 18.96a2.52 2.52 0 0 1 2.52 2.52A2.52 2.52 0 0 1 15.17 24a2.52 2.52 0 0 1-2.52-2.52v-2.52h2.52zm0-1.27a2.52 2.52 0 0 1-2.52-2.52 2.52 2.52 0 0 1 2.52-2.52h6.31A2.52 2.52 0 0 1 24 15.17a2.52 2.52 0 0 1-2.52 2.52h-6.31z"/></svg>`;

    let body;
    if (!d.oauth_configured) {
      body = `
        <div class="set-empty">
          <div class="set-empty__icon">${slackIcon(24)}</div>
          <div class="set-empty__title">Slack is not configured on this server</div>
          <div class="set-empty__desc">Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET, and SLACK_REDIRECT_URI in .env to enable the "Add to Slack" install. See the README "Slack setup" section.</div>
          <button class="btn btn-secondary btn-sm" disabled>Add to Slack <span class="tier-badge" style="margin-left:6px">Setup needed</span></button>
        </div>`;
    } else if (d.connected) {
      body = `
        <div class="set-integration-block">
          <div class="set-integration">
            <div class="set-integration__icon">${slackIcon(18)}</div>
            <div class="set-integration__text">
              <div class="set-integration__name">Slack workspace</div>
              <div class="set-integration__meta">Connected${d.workspace ? ` to ${esc(d.workspace)}` : ''}. Log deals with <code class="code-inline">/foresight lost-deal Acme $40K vs BambooHR</code></div>
            </div>
            <div class="set-integration__action">
              <span class="set-pill set-pill--active">Active</span>
              <button class="set-linkbtn set-linkbtn--danger" onclick="Settings.confirmDisconnectSlack()">Disconnect</button>
            </div>
          </div>
          ${!d.signing_configured ? `<div class="text-sm" style="color:var(--yellow)">SLACK_SIGNING_SECRET is not set. Slash commands will be rejected until it is configured.</div>` : ''}
        </div>`;
    } else {
      body = `
        <div class="set-empty">
          <div class="set-empty__icon">${slackIcon(24)}</div>
          <div class="set-empty__title">Log deals straight from Slack</div>
          <div class="set-empty__desc">Connect your workspace, then type <code class="code-inline">/foresight lost-deal Acme $40K vs BambooHR</code> in any channel to log a deal in one line.</div>
          <a class="btn btn-primary btn-sm" href="/api/slack/oauth/start">Add to Slack</a>
          ${!d.signing_configured ? `<div class="text-sm" style="color:var(--yellow);margin-top:8px">Note: SLACK_SIGNING_SECRET is not set yet, so slash commands will be rejected until it is.</div>` : ''}
        </div>`;
    }

    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Slack deal logging</div>
          <div class="set-card__desc">Log win/loss outcomes from Slack with a one-line slash command. Deal values stay private to you (responses are only ever visible to the person who runs the command).</div>
        </div>
        <div class="set-card__body">${body}</div>
      </div>`;
  },

  // ── Alert webhooks (Slack + Discord incoming) — Integrations section ─────────
  // Saves slack_webhook + discord_webhook independently of the briefing prefs
  // (which live in Notifications). The PUT /settings endpoint keeps any column
  // whose key is absent from the body, so this save never touches briefings.

  webhooksHtml(s, isProPlus) {
    const slackUrl   = s.slack_webhook || '';
    const discordUrl = s.discord_webhook || '';

    const slackIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z"/><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z"/><path d="M14 14.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z"/><path d="M15.5 19H14v1.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5z"/><path d="M10 9.5C10 8.67 9.33 8 8.5 8h-5C2.67 8 2 8.67 2 9.5S2.67 11 3.5 11h5c.83 0 1.5-.67 1.5-1.5z"/><path d="M8.5 5H10V3.5C10 2.67 9.33 2 8.5 2S7 2.67 7 3.5 7.67 5 8.5 5z"/></svg>`;
    const discordIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>`;

    const statusPill = (connected) => connected
      ? `<span class="set-pill set-pill--active">Connected</span>`
      : `<span class="set-pill set-pill--off">Not connected</span>`;

    const disabledAttr = !isProPlus ? 'disabled' : '';

    return `
      <div class="set-card ${!isProPlus ? 'is-locked' : ''}">
        <div class="set-card__head">
          <div class="set-card__title">
            Alert webhooks
            ${!isProPlus ? `<span class="tier-badge">Pro+</span>` : ''}
          </div>
          <div class="set-card__desc">Push change alerts and briefings to Slack or Discord via incoming webhook.${!isProPlus ? ' Upgrade to Pro to enable webhook notifications.' : ''}</div>
        </div>
        <div class="set-card__body" data-dirty-group>

          <!-- Slack -->
          <div class="set-integration-block">
            <div class="set-integration">
              <div class="set-integration__icon">${slackIcon}</div>
              <div class="set-integration__text">
                <div class="set-integration__name">Slack workspace</div>
                <div class="set-integration__meta">Receive alerts in a Slack channel via incoming webhook.</div>
              </div>
              <div class="set-integration__action">${statusPill(!!slackUrl)}</div>
            </div>
            <div class="webhook-row">
              <input class="form-input" id="slack-url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://hooks.slack.com/services/…"
                value="${esc(slackUrl)}" ${disabledAttr} />
              <button class="btn btn-secondary btn-sm" onclick="Settings.testWebhook('slack')" ${disabledAttr}>Test</button>
            </div>
            <span class="form-hint">Create one at api.slack.com/messaging/webhooks</span>
          </div>

          <!-- Discord -->
          <div class="set-integration-block">
            <div class="set-integration">
              <div class="set-integration__icon">${discordIcon}</div>
              <div class="set-integration__text">
                <div class="set-integration__name">Discord server</div>
                <div class="set-integration__meta">Receive alerts in a Discord channel via webhook.</div>
              </div>
              <div class="set-integration__action">${statusPill(!!discordUrl)}</div>
            </div>
            <div class="webhook-row">
              <input class="form-input" id="discord-url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/…"
                value="${esc(discordUrl)}" ${disabledAttr} />
              <button class="btn btn-secondary btn-sm" onclick="Settings.testWebhook('discord')" ${disabledAttr}>Test</button>
            </div>
            <span class="form-hint">Add a webhook in Discord: Channel Settings, then Integrations</span>
          </div>

          <div class="set-card__footer">
            <span id="webhook-save-feedback" class="set-feedback"></span>
            <button class="btn btn-primary btn-sm" data-save-btn onclick="Settings.saveWebhooks(this)" ${disabledAttr}>Save changes</button>
          </div>
        </div>
      </div>
    `;
  },

  // ── Notifications — email + briefing prefs ──────────────────────────────────
  // Webhooks moved to the Integrations section. This save only writes the
  // briefing prefs (briefings_enabled, briefing_lead_minutes); webhook columns
  // are omitted from the body so the server keeps them intact.

  notificationsHtml(s, accountEmail) {
    const emailAddr  = s.notification_email || accountEmail || '';
    const briefOn    = (s?.briefings_enabled ?? 1) === 1;
    const lead       = s?.briefing_lead_minutes ?? 30;

    const mailIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>`;
    const checkIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Notifications</div>
          <div class="set-card__desc">Where Nivaria delivers briefings and change alerts, and when.</div>
        </div>
        <div class="set-card__body" data-dirty-group>

          <!-- Email (notification address, read-only) -->
          <div class="set-integration-block">
            <div class="set-integration">
              <div class="set-integration__icon">${mailIcon}</div>
              <div class="set-integration__text">
                <div class="set-integration__name">Notification address ${emailAddr ? `<span class="set-pill set-pill--active">${checkIcon} Verified</span>` : ''}</div>
                <div class="set-integration__meta">${esc(emailAddr || 'Uses your account email')}</div>
              </div>
            </div>
            <span class="form-hint">Email briefings go to your account address. Add Slack or Discord webhooks in <a href="#/settings/integrations" class="link-accent">Integrations</a>.</span>
          </div>

          <!-- Pre-meeting briefing preferences -->
          <label class="set-switch-row" for="briefings-enabled">
            <span class="set-switch-text">
              <span class="set-switch-label">Send pre-meeting briefings</span>
              <span class="set-switch-help">When a meeting on your calendar mentions a tracked competitor, push a brief to your configured webhooks. Requires a connected calendar.</span>
            </span>
            <input type="checkbox" role="switch" id="briefings-enabled" class="set-switch"
              ${briefOn ? 'checked' : ''} aria-label="Send pre-meeting briefings" />
          </label>

          <div class="form-group">
            <label class="form-label" for="briefing-lead">Lead time</label>
            <select id="briefing-lead" class="form-input" style="max-width:220px">
              <option value="15" ${lead === 15 ? 'selected' : ''}>15 minutes before</option>
              <option value="30" ${lead === 30 ? 'selected' : ''}>30 minutes before</option>
              <option value="60" ${lead === 60 ? 'selected' : ''}>60 minutes before</option>
            </select>
          </div>

          <div class="set-card__footer">
            <span id="notif-save-feedback" class="set-feedback"></span>
            <button class="btn btn-primary btn-sm" data-save-btn onclick="Settings.saveNotifications(this)">Save changes</button>
          </div>
        </div>
      </div>
    `;
  },

  // ── Save handlers ───────────────────────────────────────────────────────────

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
      if (Settings._ctx) Settings._ctx.ctxData = { context: payload };
      btn.textContent = original;
      Settings._flashSaved(btn);
      toast('Business context saved. Applies to future analyses.', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      toast(e.message, 'error');
    }
  },

  // Save Slack + Discord incoming webhooks. Sends only the webhook keys so the
  // server leaves briefing prefs (Notifications) untouched.
  async saveWebhooks(btn) {
    const slack    = document.getElementById('slack-url')?.value.trim() || '';
    const discord  = document.getElementById('discord-url')?.value.trim() || '';
    const feedback  = document.getElementById('webhook-save-feedback');

    const setFeedback = (msg, isErr) => {
      if (!feedback) return;
      feedback.textContent = msg;
      feedback.style.color = isErr ? 'var(--red)' : 'var(--txt-3)';
    };

    if (slack   && !Settings._isValidSlackWebhook(slack)) {
      setFeedback('Slack webhook must be https://hooks.slack.com/services/…', true);
      toast('Invalid Slack webhook URL', 'error');
      return;
    }
    if (discord && !Settings._isValidDiscordWebhook(discord)) {
      setFeedback('Discord webhook must be https://discord.com/api/webhooks/…', true);
      toast('Invalid Discord webhook URL', 'error');
      return;
    }

    const payload = {
      slack_webhook:   slack   || null,
      discord_webhook: discord || null,
    };

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    setFeedback('', false);
    try {
      await API.saveSettings(payload);
      if (Settings._ctx) {
        Settings._ctx.settings = { ...Settings._ctx.settings, slack_webhook: payload.slack_webhook, discord_webhook: payload.discord_webhook };
      }
      btn.textContent = original;
      Settings._flashSaved(btn);
      toast('Webhooks saved', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      setFeedback(e.message, true);
      toast(e.message, 'error');
      if (e.upgrade_required) navigate('/pricing');
    }
  },

  async saveNotifications(btn) {
    const enabledEl = document.getElementById('briefings-enabled');
    const leadEl    = document.getElementById('briefing-lead');
    const feedback  = document.getElementById('notif-save-feedback');

    const setFeedback = (msg, isErr) => {
      if (!feedback) return;
      feedback.textContent = msg;
      feedback.style.color = isErr ? 'var(--red)' : 'var(--txt-3)';
    };

    // Only briefing prefs — webhooks live in Integrations and are omitted here so
    // the partial-update-safe endpoint leaves them in place.
    const payload = {
      briefings_enabled:     enabledEl ? (enabledEl.checked ? 1 : 0) : undefined,
      briefing_lead_minutes: leadEl    ? parseInt(leadEl.value, 10)  : undefined,
    };

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    setFeedback('', false);
    try {
      await API.saveSettings(payload);
      if (Settings._ctx) {
        Settings._ctx.settings = { ...Settings._ctx.settings, briefings_enabled: payload.briefings_enabled, briefing_lead_minutes: payload.briefing_lead_minutes };
      }
      btn.textContent = original;
      Settings._flashSaved(btn);
      toast('Notification settings saved', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      setFeedback(e.message, true);
      toast(e.message, 'error');
    }
  },

  // Save-success micro-interaction: swap the button to a check + "Saved" for
  // 1.5s, then restore. Save buttons stay disabled afterward (no pending
  // changes) until the user edits a field again (see _wireDirty).
  _flashSaved(btn, label = 'Saved') {
    if (!btn) return;
    if (btn._restoreTimer) clearTimeout(btn._restoreTimer);
    if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
    btn.classList.add('is-saved');
    btn.disabled = true;
    btn.innerHTML = `<span class="set-save-check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span> ${label}`;
    btn._restoreTimer = setTimeout(() => {
      btn.classList.remove('is-saved');
      btn.innerHTML = btn.dataset.origHtml;
      btn.disabled = btn.hasAttribute('data-save-btn'); // clean = disabled until next edit
      delete btn.dataset.origHtml;
    }, 1500);
  },

  // Arm each card's Save button only when one of its fields changes, so a
  // pristine card shows a disabled (no-op) Save. Presentational only.
  _wireDirty() {
    document.querySelectorAll('[data-dirty-group]').forEach(group => {
      const btn = group.querySelector('[data-save-btn]');
      if (!btn) return;
      // Start clean (disabled). A locked, free-tier webhook card has disabled
      // fields, so the :not([disabled]) selector below attaches no listeners and
      // its Save stays disabled — exactly the prior behavior.
      btn.disabled = true;
      const arm = () => { if (btn.disabled && !btn.classList.contains('is-saved')) btn.disabled = false; };
      group.querySelectorAll('input:not([disabled]), textarea:not([disabled]), select:not([disabled])').forEach(field => {
        field.addEventListener('input', arm);
        field.addEventListener('change', arm);
      });
    });
  },

  // ── Webhook test + API key + misc (unchanged behavior) ──────────────────────

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

  // Client-side webhook URL shape check. Mirrors the validators on the server
  // (src/routes/settings.js) so users get instant feedback instead of paying
  // a round-trip to discover a typo. Server-side validation remains the
  // source of truth.
  _isValidSlackWebhook(url) {
    if (!url) return true; // empty = clear
    try {
      const u = new URL(url);
      return u.protocol === 'https:' &&
        (u.hostname === 'hooks.slack.com' || u.hostname.endsWith('.slack.com'));
    } catch { return false; }
  },
  _isValidDiscordWebhook(url) {
    if (!url) return true;
    try {
      const u = new URL(url);
      return u.protocol === 'https:' &&
        (u.hostname === 'discord.com' || u.hostname === 'discordapp.com' ||
         u.hostname.endsWith('.discord.com'));
    } catch { return false; }
  },

  // ── Slack disconnect (deal logging) ─────────────────────────────────────────

  confirmDisconnectSlack() {
    openModal(`
      <div class="modal-header">
        <div class="modal-title">Disconnect Slack</div>
        <button class="modal-close" onclick="closeModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body"><p style="color:var(--txt-2);line-height:1.7">Disconnect Slack? The <code class="code-inline">/foresight</code> slash command will stop logging deals until you reconnect.</p></div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="Settings._doDisconnectSlack()">Disconnect</button>
      </div>
    `);
  },

  async _doDisconnectSlack() {
    try {
      await API.disconnectSlack();
      closeModal();
      toast('Slack disconnected.', 'success');
      Settings.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  // ── Calendar disconnect ─────────────────────────────────────────────────────

  promptDisconnect(provider, btn) {
    const action = btn.closest('.set-integration__action');
    if (!action) return Settings.confirmDisconnect(provider);
    action.dataset.orig = action.innerHTML;
    action.innerHTML = `
      <span class="set-inline-confirm">
        <span>Disconnect?</span>
        <button class="set-linkbtn set-linkbtn--danger" onclick="Settings.confirmDisconnect('${provider}')">Yes, disconnect</button>
        <button class="set-linkbtn" onclick="Settings.cancelDisconnect(this)">Cancel</button>
      </span>`;
  },

  cancelDisconnect(btn) {
    const action = btn.closest('.set-integration__action');
    if (action && action.dataset.orig) {
      action.innerHTML = action.dataset.orig;
      delete action.dataset.orig;
    }
  },

  async confirmDisconnect(provider) {
    try {
      await API.disconnectCalendar(provider);
      toast('Calendar disconnected. Pre-meeting briefings will stop until you reconnect.', 'success');
      Settings.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  // ── OAuth return params ─────────────────────────────────────────────────────
  // Handle ?calendar_connected / ?calendar_error / ?slack_connected / ?slack_error
  // appended by the OAuth callbacks. The router parses the hash's query string
  // and passes a URLSearchParams; direct callers (re-render after disconnect)
  // fall back to parsing the live hash so these stay usable standalone.

  handleCalendarReturnParams(routeQuery) {
    let params = routeQuery instanceof URLSearchParams ? routeQuery : null;
    if (!params) {
      const hash = window.location.hash || '';
      const qIdx = hash.indexOf('?');
      if (qIdx === -1) return;
      params = new URLSearchParams(hash.slice(qIdx + 1));
    }
    if (params.has('calendar_connected')) {
      toast(`${params.get('calendar_connected')} calendar connected. Initial sync running.`, 'success');
    } else if (params.has('calendar_error')) {
      toast(`Calendar connect failed: ${params.get('calendar_error')}`, 'error');
    } else {
      return;
    }
    Settings._stripReturnQuery();
  },

  handleSlackReturnParams(routeQuery) {
    let params = routeQuery instanceof URLSearchParams ? routeQuery : null;
    if (!params) {
      const hash = window.location.hash || '';
      const qIdx = hash.indexOf('?');
      if (qIdx === -1) return;
      params = new URLSearchParams(hash.slice(qIdx + 1));
    }
    if (params.has('slack_connected')) {
      toast('Slack connected. Try /foresight lost-deal in any channel.', 'success');
    } else if (params.has('slack_error')) {
      toast(`Slack connect failed: ${params.get('slack_error')}`, 'error');
    } else {
      return;
    }
    Settings._stripReturnQuery();
  },

  // Strip the query params from the hash so a refresh doesn't re-toast, while
  // keeping the section path (e.g. #/settings/integrations).
  _stripReturnQuery() {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx !== -1) history.replaceState(null, '', hash.slice(0, qIdx));
  },
};
window.Settings = Settings;
