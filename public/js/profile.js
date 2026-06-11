// Profile — Pattern 2 sidebar layout. A left vertical nav switches between four
// independent section panels. Sections:
//   details · voice · integrations · account
// This is the per-user home: identity, how Nivaria writes on your behalf, the
// per-user integrations (calendar, Slack, alert webhooks), and the account
// danger zone. Workspace-level settings (business context, notifications,
// billing) live on the separate Settings page (public/js/settings.js).
//
// Each section is a real hash sub-route (#/profile/<section>) so deep links,
// browser back/forward, and OAuth return redirects all work. The fetched data
// bundle is cached on Profile._ctx; tab switches re-render the active panel from
// cache (no skeleton flash), while a bare Profile.render() call (e.g. after a
// disconnect) refetches fresh data and stays on the current section.
//
// Reuses Settings._wireDirty / Settings._flashSaved for the shared save-button
// micro-interactions (both modules are global; calls happen at runtime).

const Profile = {
  _ctx: null,            // cached { user, voiceData, settings, calData, slackData, subData }
  _activeSection: 'details',

  SECTIONS: [
    { id: 'details',      label: 'Your details',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>` },
    { id: 'voice',        label: 'Voice profile', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>` },
    { id: 'integrations', label: 'Integrations',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7H6a3 3 0 0 0 0 6h3"/><path d="M15 17h3a3 3 0 0 0 0-6h-3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>` },
    { id: 'account',      label: 'Account',       icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>` },
  ],

  _RETURN_PARAMS: ['calendar_connected', 'calendar_error', 'slack_connected', 'slack_error'],

  // Resolve which section to show from an explicit id, then from any OAuth return
  // params (so an OAuth callback landing on #/profile?calendar_connected=… shows
  // Integrations), then the last active section, then the details default.
  _resolveSection(section, routeQuery) {
    if (section) return section;
    if (routeQuery instanceof URLSearchParams &&
        Profile._RETURN_PARAMS.some(k => routeQuery.has(k))) return 'integrations';
    return Profile._activeSection || 'details';
  },

  async render(routeQuery, section) {
    const fromRouter = arguments.length > 0; // bare Profile.render() == mutation re-render
    const target = Profile._resolveSection(section, routeQuery);
    Profile._activeSection = target;

    const hasReturnParams = routeQuery instanceof URLSearchParams &&
      Profile._RETURN_PARAMS.some(k => routeQuery.has(k));
    const shellExists = !!document.getElementById('profile-shell');
    // Refetch when: no cache, mutation re-render, OAuth return (state changed),
    // or we're (re)entering the profile fresh (no shell mounted).
    const needFetch = !Profile._ctx || !fromRouter || hasReturnParams || !shellExists;

    if (needFetch) {
      try {
        const [user, voiceData, settings, calData, slackData, subData] = await Promise.all([
          API.getMe().catch(() => (window.App && App.user) || null),
          API.getVoiceProfile().catch(() => null),
          API.getSettings().then(r => r.settings || r || {}).catch(() => ({})),
          API.getCalendarConnections().catch(() => ({ encryption_configured: false, connections: [] })),
          API.getSlackConnection().catch(() => ({ oauth_configured: false, signing_configured: false, connected: false })),
          API.getSubscription().catch(() => null),
        ]);
        Profile._ctx = { user: user || (window.App && App.user) || {}, voiceData, settings: settings || {}, calData, slackData, subData };
      } catch (e) {
        el('page-root').innerHTML = `
          <div class="empty-state">
            <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
            <div class="empty-title">Error loading profile</div>
            <div class="empty-desc">${esc(e.message)}</div>
          </div>`;
        return;
      }
    }

    el('page-root').innerHTML = Profile.shellHtml(Profile._ctx, target);
    Settings._wireDirty();
    Profile.handleCalendarReturnParams(routeQuery);
    Profile.handleSlackReturnParams(routeQuery);
  },

  // Navigate to a section. Anchors already carry the href; this is the keyboard/
  // programmatic path and keeps the URL the single source of truth.
  go(section) { navigate('/profile/' + section); },

  // ── Shell: identity header + left nav + active panel ────────────────────────

  shellHtml(ctx, active) {
    const { user } = ctx;
    const section = Profile.SECTIONS.find(x => x.id === active) || Profile.SECTIONS[0];

    const nav = Profile.SECTIONS.map(sx => {
      const on = sx.id === active;
      return `
        <a href="#/profile/${sx.id}" class="settings-nav__item ${on ? 'is-active' : ''}"
           data-section="${sx.id}" aria-current="${on ? 'page' : 'false'}">
          <span class="settings-nav__icon">${sx.icon}</span>
          <span class="settings-nav__label">${sx.label}</span>
        </a>`;
    }).join('');

    return `
      <div class="settings-page settings-page--split profile-page">
        <div class="settings-page-header">
          <div>
            <div class="settings-page-title">Profile</div>
            <div class="settings-page-subtitle">Your personal details, integrations, and how Nivaria writes on your behalf.</div>
          </div>
          <div class="settings-identity">
            <span>${esc(user?.email || '')}</span>
          </div>
        </div>
        <div class="settings-page-divider"></div>

        <div class="settings-shell" id="profile-shell">
          <nav class="settings-nav" aria-label="Profile sections">${nav}</nav>
          <div class="settings-panel" id="profile-panel" role="region" aria-label="${esc(section.label)}">
            <div class="settings-stack">${Profile.panelHtml(active, ctx)}</div>
          </div>
        </div>
      </div>`;
  },

  panelHtml(section, ctx) {
    const { user, voiceData, settings: s, calData, slackData, subData } = ctx;
    const tier = (subData && subData.effectiveTier) || 'free';
    const isProPlus = tier === 'pro' || tier === 'team' || tier === 'business';

    switch (section) {
      case 'details':
        return Profile.identityHtml(user) + Profile.securityHtml(user);
      case 'voice':
        return Profile.voiceProfileHtml(voiceData);
      case 'integrations':
        return Profile.calendarHtml(s, calData) + Profile.slackHtml(slackData) + Profile.webhooksHtml(s, isProPlus);
      case 'account':
        return Profile.accountHtml(user) + Profile.gdprHtml();
      default:
        return Profile.identityHtml(user) + Profile.securityHtml(user);
    }
  },

  // ── Name (timezone is captured + backfilled silently; no UI) ─────────────────

  identityHtml(user) {
    const name = user?.first_name || '';
    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Your details</div>
        </div>
        <div class="set-card__body" data-dirty-group>
          <div class="form-group">
            <label class="form-label" for="profile-name">First name</label>
            <input class="form-input" id="profile-name" maxlength="50"
              placeholder="What should we call you?" value="${esc(name)}" />
          </div>
          <div class="set-card__footer">
            <button class="btn btn-primary btn-sm" data-save-btn onclick="Profile.saveProfile(this)">Save changes</button>
          </div>
        </div>
      </div>`;
  },

  async saveProfile(btn) {
    const firstName = document.getElementById('profile-name').value.trim();
    if (!firstName) { toast('Enter your name first.', 'error'); return; }

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      const r = await API.updateProfile({ firstName });
      if (window.App && App.user && r.user) {
        App.user.first_name = r.user.first_name;
        App.user.name       = r.user.name;
        App.updateUserUI?.();
      }
      if (Profile._ctx && Profile._ctx.user) {
        Profile._ctx.user.first_name = r.user?.first_name;
        Profile._ctx.user.name       = r.user?.name;
      }
      // The greeting is cached per session; clear it so the new name takes
      // effect on the next dashboard render.
      try { sessionStorage.removeItem('cs-greeting'); } catch (_) {}
      // A saved name means the dashboard "add your name" prompt is done for good.
      try { localStorage.setItem('cs-name-prompt-dismissed', '1'); } catch (_) {}
      btn.textContent = original;
      Settings._flashSaved(btn);
      toast('Profile saved.', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      toast(e.message, 'error');
    }
  },

  // ── Sign-in & security (email read-only + password) ─────────────────────────

  securityHtml(user) {
    const email = user?.email || '';
    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Sign-in &amp; security</div>
          <div class="set-card__desc">The email you sign in with, and your password.</div>
        </div>
        <div class="set-card__body">
          <div class="form-group">
            <label class="form-label">Email</label>
            <div class="set-static">
              ${esc(email || '-')}
              <span class="set-pill set-pill--active" title="Verified">Verified</span>
            </div>
            <span class="form-hint">To change the email on your account, contact <a href="mailto:support@nivaria.app" class="link-accent">support@nivaria.app</a>.</span>
          </div>

          <div class="set-integration-block">
            <div class="set-integration">
              <div class="set-integration__text">
                <div class="set-integration__name">Password</div>
                <div class="set-integration__meta">We'll email a reset code to ${esc(email || 'your address')} to set a new password.</div>
              </div>
              <div class="set-integration__action">
                <button class="btn btn-secondary btn-sm" onclick="Profile.changePassword()">Change password</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  },

  // Reuses the existing forgot-password reset flow (OTP → set new password).
  // Deep-links into the auth page in "forgot" mode with the email pre-filled.
  changePassword() {
    const email = (window.App && App.user && App.user.email) || '';
    window.location.href = '/login?forgot=1' + (email ? '&email=' + encodeURIComponent(email) : '');
  },

  // ── Voice profile (Phase 8) ──────────────────────────────────────────────────

  voiceProfileHtml(voiceData) {
    const v = voiceData?.profile || {};
    const defaults = voiceData?.defaults || { formality: 'balanced', contraction_style: 'sometimes', opener_style: 'direct', sentence_rhythm: 'mixed' };
    const isEmpty = !(v.formality || v.contraction_style || v.opener_style || v.sentence_rhythm ||
                      v.sign_off_examples || v.voice_sample || v.avoid_phrases);

    const editor = Profile.voiceEditorHtml(v, defaults);

    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Voice profile</div>
          <div class="set-card__desc">Drives the Outreach section on your briefs. Tune these so generated messages sound like you, not like a chatbot. Updates apply to future generations only. Already-generated outreach is unchanged until you regenerate it.</div>
        </div>
        ${isEmpty ? `
          <div id="vp-empty" class="set-empty">
            <div class="set-empty__icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </div>
            <div class="set-empty__title">Your voice profile is empty</div>
            <div class="set-empty__desc">Nivaria will use sensible defaults when generating outreach. Set it up to make every message sound like you.</div>
            <button class="btn btn-primary btn-sm" onclick="Profile.expandVoiceProfile()">Set up voice profile</button>
          </div>
          <div id="vp-editor" class="set-card__body" data-dirty-group style="display:none;margin-top:20px">${editor}</div>
        ` : `
          <div id="vp-editor" class="set-card__body" data-dirty-group>${editor}</div>
        `}
      </div>
    `;
  },

  voiceEditorHtml(v, defaults) {
    const radio = (name, value, label, helper) => {
      const isChecked = v[name] === value || (!v[name] && defaults[name] === value);
      return `
      <label class="voice-radio">
        <input type="radio" name="vp-${name}" value="${value}" ${isChecked ? 'checked' : ''} />
        <span class="voice-radio-body">
          <span class="voice-radio-label">${label}</span>
          ${helper ? `<span class="voice-radio-helper">${helper}</span>` : ''}
        </span>
      </label>`;
    };

    return `
      <div class="form-group">
        <label class="form-label">Formality</label>
        <div class="voice-radio-group">
          ${radio('formality', 'casual',   'Casual',   'Like texting a colleague')}
          ${radio('formality', 'balanced', 'Balanced', 'Professional but human')}
          ${radio('formality', 'formal',   'Formal',   'Buttoned-up enterprise')}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Contractions</label>
        <div class="voice-radio-group">
          ${radio('contraction_style', 'always',    'Always use them', `"don't", "I'll", "we're"`)}
          ${radio('contraction_style', 'sometimes', 'Sometimes',       'Natural mix')}
          ${radio('contraction_style', 'never',     'Never',           `"do not", "I will", "we are"`)}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Opener style</label>
        <div class="voice-radio-group voice-radio-group--stack">
          ${radio('opener_style', 'direct',
            'Direct',
            `<em>"Saw the BambooHR change. Wanted to flag it before our call"</em>`)}
          ${radio('opener_style', 'warm',
            'Warm',
            `<em>"Hope your week's going well. Quick heads up on BambooHR"</em>`)}
          ${radio('opener_style', 'context-first',
            'Context-first',
            `<em>"BambooHR just made a pricing change that affects how we should approach this deal"</em>`)}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Sentence rhythm</label>
        <div class="voice-radio-group voice-radio-group--stack">
          ${radio('sentence_rhythm', 'short_punchy',
            'Short and punchy',
            `<em>"They dropped their price. Big deal."</em>`)}
          ${radio('sentence_rhythm', 'mixed',
            'Mixed lengths',
            `<em>"Acme just cut their Pro plan. It's aggressive, and it changes how we should pitch."</em>`)}
          ${radio('sentence_rhythm', 'measured',
            'Longer measured sentences',
            `<em>"Acme has reduced their Pro plan by 30%, which represents a substantive shift in market positioning."</em>`)}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Sign-off examples</label>
        <textarea class="form-input form-textarea" id="vp-signoff" rows="3" maxlength="1000"
          placeholder="Cheers,&#10;Eddy">${esc(v.sign_off_examples || '')}</textarea>
        <span class="form-hint">How do you usually sign off? Paste 2-3 examples. The AI will mirror these instead of inventing closers.</span>
      </div>

      <div class="form-group">
        <label class="form-label">Voice sample</label>
        <textarea class="form-input form-textarea" id="vp-voice-sample" rows="6" maxlength="4000"
          placeholder="Paste 1-2 short examples of emails you've written.">${esc(v.voice_sample || '')}</textarea>
        <span class="form-hint">Optional but powerful. The AI studies your phrasing, rhythm, and word choice to write like you.</span>
      </div>

      <div class="form-group">
        <label class="form-label">Phrases to avoid</label>
        <textarea class="form-input form-textarea" id="vp-avoid" rows="3" maxlength="1000"
          placeholder="delve, leverage, synergy, circle back, I hope this email finds you well">${esc(v.avoid_phrases || '')}</textarea>
        <span class="form-hint">Comma-separated. Anything you list here will never appear in your outreach.</span>
      </div>

      <div class="set-card__footer">
        <button class="btn btn-primary btn-sm" data-save-btn onclick="Profile.saveVoiceProfile(this)">Save changes</button>
      </div>
    `;
  },

  expandVoiceProfile() {
    const empty = document.getElementById('vp-empty');
    const editor = document.getElementById('vp-editor');
    if (empty) empty.style.display = 'none';
    if (editor) {
      editor.style.display = '';
      const btn = editor.querySelector('[data-save-btn]');
      if (btn) btn.disabled = false;
    }
  },

  async saveVoiceProfile(btn) {
    const getRadio = (name) => {
      const checked = document.querySelector(`input[name="vp-${name}"]:checked`);
      return checked ? checked.value : null;
    };

    const payload = {
      formality:         getRadio('formality'),
      contraction_style: getRadio('contraction_style'),
      opener_style:      getRadio('opener_style'),
      sentence_rhythm:   getRadio('sentence_rhythm'),
      sign_off_examples: el('vp-signoff').value.trim(),
      voice_sample:      el('vp-voice-sample').value.trim(),
      avoid_phrases:     el('vp-avoid').value.trim(),
    };

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      await API.saveVoiceProfile(payload);
      if (Profile._ctx) Profile._ctx.voiceData = { ...(Profile._ctx.voiceData || {}), profile: payload };
      btn.textContent = original;
      Settings._flashSaved(btn);
      toast('Voice profile saved. Applies to future outreach.', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      toast(e.message, 'error');
    }
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
          <div class="set-card__desc">Connect a calendar so Nivaria can match upcoming meetings to tracked competitors. Briefing delivery preferences live in Settings, under Notifications.</div>
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
                  <button class="set-linkbtn set-linkbtn--danger" onclick="Profile.promptDisconnect('google', this)">Disconnect</button>
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
              <button class="set-linkbtn set-linkbtn--danger" onclick="Profile.confirmDisconnectSlack()">Disconnect</button>
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
  // (which live in Settings → Notifications). The PUT /settings endpoint keeps
  // any column whose key is absent from the body, so this save never touches
  // briefings.

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
              <button class="btn btn-secondary btn-sm" onclick="Profile.testWebhook('slack')" ${disabledAttr}>Test</button>
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
              <button class="btn btn-secondary btn-sm" onclick="Profile.testWebhook('discord')" ${disabledAttr}>Test</button>
            </div>
            <span class="form-hint">Add a webhook in Discord: Channel Settings, then Integrations</span>
          </div>

          <div class="set-card__footer">
            <span id="webhook-save-feedback" class="set-feedback"></span>
            <button class="btn btn-primary btn-sm" data-save-btn onclick="Profile.saveWebhooks(this)" ${disabledAttr}>Save changes</button>
          </div>
        </div>
      </div>
    `;
  },

  // Save Slack + Discord incoming webhooks. Sends only the webhook keys so the
  // server leaves briefing prefs (Settings → Notifications) untouched.
  async saveWebhooks(btn) {
    const slack    = document.getElementById('slack-url')?.value.trim() || '';
    const discord  = document.getElementById('discord-url')?.value.trim() || '';
    const feedback  = document.getElementById('webhook-save-feedback');

    const setFeedback = (msg, isErr) => {
      if (!feedback) return;
      feedback.textContent = msg;
      feedback.style.color = isErr ? 'var(--red)' : 'var(--txt-3)';
    };

    if (slack   && !Profile._isValidSlackWebhook(slack)) {
      setFeedback('Slack webhook must be https://hooks.slack.com/services/…', true);
      toast('Invalid Slack webhook URL', 'error');
      return;
    }
    if (discord && !Profile._isValidDiscordWebhook(discord)) {
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
      if (Profile._ctx) {
        Profile._ctx.settings = { ...Profile._ctx.settings, slack_webhook: payload.slack_webhook, discord_webhook: payload.discord_webhook };
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

  async testWebhook(type) {
    const url = document.getElementById(`${type}-url`)?.value.trim();
    if (!url) return toast('Enter a webhook URL first', 'error');

    const btn = document.querySelector(`button[onclick="Profile.testWebhook('${type}')"]`);
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
        <button class="btn btn-danger" onclick="Profile._doDisconnectSlack()">Disconnect</button>
      </div>
    `);
  },

  async _doDisconnectSlack() {
    try {
      await API.disconnectSlack();
      closeModal();
      toast('Slack disconnected.', 'success');
      Profile.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  // ── Calendar disconnect ─────────────────────────────────────────────────────

  promptDisconnect(provider, btn) {
    const action = btn.closest('.set-integration__action');
    if (!action) return Profile.confirmDisconnect(provider);
    action.dataset.orig = action.innerHTML;
    action.innerHTML = `
      <span class="set-inline-confirm">
        <span>Disconnect?</span>
        <button class="set-linkbtn set-linkbtn--danger" onclick="Profile.confirmDisconnect('${provider}')">Yes, disconnect</button>
        <button class="set-linkbtn" onclick="Profile.cancelDisconnect(this)">Cancel</button>
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
      Profile.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  // ── Account — programmatic API access ────────────────────────────────────────

  accountHtml(user) {
    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">API access</div>
          <div class="set-card__desc">Your programmatic API key.</div>
        </div>
        <div class="set-card__body">
          <div class="form-group">
            <label class="form-label">API key</label>
            <div class="api-key-row">
              <div class="api-key-value" id="api-key-display" data-full="${esc(user?.api_key || '')}">
                ${esc(user?.api_key?.substring(0, 8))}••••••••••••••••••••
              </div>
              <button class="btn btn-secondary btn-sm" onclick="Profile.toggleApiKey()">Show</button>
              <button class="btn btn-ghost btn-sm" onclick="Profile.copyApiKey('${esc(user?.api_key || '')}')">Copy</button>
            </div>
            <span class="form-hint">Include as <code class="code-inline">X-Api-Key</code> header in API requests.</span>
          </div>
        </div>
      </div>`;
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
    Profile._stripReturnQuery();
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
    Profile._stripReturnQuery();
  },

  // Strip the query params from the hash so a refresh doesn't re-toast, while
  // keeping the section path (e.g. #/profile/integrations).
  _stripReturnQuery() {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx !== -1) history.replaceState(null, '', hash.slice(0, qIdx));
  },
};
window.Profile = Profile;
