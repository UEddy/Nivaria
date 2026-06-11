// Profile — per-user identity, separate from workspace Settings.
//   · First name (editable; greeting + dashboard use it)
//   · Email (read-only; no self-serve email change — contact support)
//   · Timezone (auto-detected from the browser, editable, persists once changed)
//   · Password (reuses the existing forgot-password reset flow)
//   · Voice profile (how this individual writes — drives outreach)
//
// Reuses Settings._wireDirty / Settings._flashSaved for the shared save-button
// micro-interactions (both modules are global; calls happen at runtime).

const Profile = {
  async render() {
    let user, voiceData;
    try {
      [user, voiceData] = await Promise.all([
        API.getMe().catch(() => (window.App && App.user) || null),
        API.getVoiceProfile().catch(() => null),
      ]);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Error loading profile</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
      return;
    }
    if (!user) user = (window.App && App.user) || {};

    el('page-root').innerHTML = Profile.html(user, voiceData);
    Settings._wireDirty();
  },

  html(user, voiceData) {
    return `
      <div class="settings-page profile-page">
        <div class="settings-page-header">
          <div>
            <div class="settings-page-title">Profile</div>
            <div class="settings-page-subtitle">Your personal details and how Nivaria writes on your behalf.</div>
          </div>
          <div class="settings-identity">
            <span>${esc(user?.email || '')}</span>
          </div>
        </div>
        <div class="settings-page-divider"></div>

        <div class="settings-stack">
          ${Profile.identityHtml(user)}
          ${Profile.securityHtml(user)}
          ${Profile.voiceProfileHtml(voiceData)}
        </div>
      </div>`;
  },

  // ── Name + timezone ─────────────────────────────────────────────────────────

  identityHtml(user) {
    const name = user?.first_name || '';
    // The browser's IANA zone, used to pre-fill when the account has none stored
    // and to label the field. We never auto-SAVE it — persistence only happens
    // when the user hits Save, so a previously chosen zone is never overwritten.
    let detected = 'UTC';
    try { detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) {}
    const tz = user?.timezone || detected;

    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Your details</div>
          <div class="set-card__desc">We greet you by name on the dashboard, and use your timezone to time that greeting to your local morning, afternoon, and evening.</div>
        </div>
        <div class="set-card__body" data-dirty-group>
          <div class="set-row-2">
            <div class="form-group">
              <label class="form-label" for="profile-name">First name</label>
              <input class="form-input" id="profile-name" maxlength="50"
                placeholder="What should we call you?" value="${esc(name)}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="profile-tz">Timezone <span class="form-label-note">(detected automatically)</span></label>
              <select class="form-input" id="profile-tz" data-detected="${esc(detected)}">${Profile.timezoneOptions(tz)}</select>
              <span class="form-hint">Auto-detected from your browser. Change it if it's wrong — your choice sticks.</span>
            </div>
          </div>
          <div class="set-card__footer">
            <button class="btn btn-primary btn-sm" data-save-btn onclick="Profile.saveProfile(this)">Save changes</button>
          </div>
        </div>
      </div>`;
  },

  // Build the timezone <option> list. Prefers the full IANA set via
  // Intl.supportedValuesOf (all modern engines), falling back to a curated
  // shortlist. Guarantees 'UTC' and the user's current value are present.
  timezoneOptions(current) {
    let zones = [];
    try { if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone'); } catch (_) {}
    if (!zones || !zones.length) {
      zones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Africa/Lagos',
        'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai',
        'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
    }
    if (!zones.includes('UTC')) zones = ['UTC', ...zones];
    if (current && !zones.includes(current)) zones = [current, ...zones];
    return zones.map(z => `<option value="${esc(z)}" ${z === current ? 'selected' : ''}>${esc(z)}</option>`).join('');
  },

  async saveProfile(btn) {
    const firstName = document.getElementById('profile-name').value.trim();
    const timezone  = document.getElementById('profile-tz').value;

    // Only send the name when non-empty so a timezone-only change can't trip the
    // server's "name is required" validation for accounts that have no name yet.
    const payload = { timezone };
    if (firstName) payload.firstName = firstName;

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      const r = await API.updateProfile(payload);
      if (window.App && App.user && r.user) {
        App.user.first_name = r.user.first_name;
        App.user.name       = r.user.name;
        App.user.timezone   = r.user.timezone;
        App.updateUserUI?.();
      }
      // The greeting is cached per session; clear it so the new name/timezone
      // takes effect on the next dashboard render.
      try { sessionStorage.removeItem('cs-greeting'); } catch (_) {}
      // A saved name means the dashboard "add your name" prompt is done for good.
      if (firstName) { try { localStorage.setItem('cs-name-prompt-dismissed', '1'); } catch (_) {} }
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

  // ── Voice profile (Phase 8) — moved from Settings ───────────────────────────

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
      btn.textContent = original;
      Settings._flashSaved(btn);
      toast('Voice profile saved. Applies to future outreach.', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      toast(e.message, 'error');
    }
  },
};
window.Profile = Profile;
