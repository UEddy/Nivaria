// Phase 6 + Phase 8 — onboarding form.
//
// Two sequential optional steps:
//   Step 1 — business context (Phase 6)
//   Step 2 — voice profile     (Phase 8)
//
// Each step can be saved-and-continued or skipped. State lives in a single
// rendered card; on transition between steps we re-render in place.
//
// Routes:
//   #/onboarding         → first-time setup (after register/verify)
//   #/onboarding?from=settings → user opened it from the dashboard banner

const Onboarding = {
  _step:    1,
  _context: {},
  _voice:   {},

  async render() {
    el('topbar-actions').innerHTML = '';

    let ctxData, voiceData;
    try {
      [ctxData, voiceData] = await Promise.all([
        API.getUserContext(),
        API.getVoiceProfile().catch(() => null),
      ]);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Could not load onboarding</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
      return;
    }

    Onboarding._context = ctxData?.context || {};
    Onboarding._voice   = voiceData?.profile || {};
    Onboarding._step    = 1;
    Onboarding._draw();
  },

  _draw() {
    if (Onboarding._step === 1) {
      el('page-root').innerHTML = Onboarding.htmlStep1(Onboarding._context);
    } else if (Onboarding._step === 2) {
      el('page-root').innerHTML = Onboarding.htmlStep2(Onboarding._voice);
    } else {
      el('page-root').innerHTML = Onboarding.htmlStep3();
    }
  },

  // ── Step 1: business context ────────────────────────────────────────────

  htmlStep1(c) {
    return `
      <div class="onboarding-wrap">
        <div class="onboarding-card">
          <div class="onboarding-step-indicator">
            <span class="onboarding-step onboarding-step--active">1</span>
            <span class="onboarding-step-bar"></span>
            <span class="onboarding-step">2</span>
            <span class="onboarding-step-bar"></span>
            <span class="onboarding-step">3</span>
            <span class="onboarding-step-label">Step 1 of 3 · Business context</span>
          </div>

          <div class="onboarding-header">
            <div class="onboarding-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
            </div>
            <div>
              <h2 class="onboarding-title">Tell us about your business</h2>
              <p class="onboarding-sub">Foresight uses this context to write briefs from your strategic perspective. All fields are optional. You can edit any of this later in Settings.</p>
            </div>
          </div>

          <form id="onboarding-form" class="onboarding-form" onsubmit="event.preventDefault(); Onboarding.submitStep1();">

            <div class="form-group">
              <label class="form-label">Company name</label>
              <input class="form-input" id="ob-company-name" maxlength="200"
                placeholder="What's your company called?" value="${esc(c.company_name || '')}" />
              <span class="form-hint">Shown on your briefs as "Analyzed for: [your company]".</span>
            </div>

            <div class="form-group">
              <label class="form-label">What we sell</label>
              <textarea class="form-input form-textarea" id="ob-what-we-sell" rows="3" maxlength="5000"
                placeholder="Describe your product in 1 to 3 sentences.">${esc(c.what_we_sell || '')}</textarea>
            </div>

            <div class="form-group">
              <label class="form-label">Target ICP</label>
              <textarea class="form-input form-textarea" id="ob-target-icp" rows="3" maxlength="5000"
                placeholder="Who do you sell to? Industry, company size, and the typical role you sell to.">${esc(c.target_icp || '')}</textarea>
            </div>

            <div class="form-group">
              <label class="form-label">Our positioning</label>
              <textarea class="form-input form-textarea" id="ob-our-positioning" rows="3" maxlength="5000"
                placeholder="How do you differentiate from competitors?">${esc(c.our_positioning || '')}</textarea>
            </div>

            <div class="form-row two-col">
              <div class="form-group">
                <label class="form-label">Typical deal size</label>
                <select class="form-input" id="ob-deal-size">
                  <option value=""           ${!c.typical_deal_size ? 'selected' : ''}>Select</option>
                  <option value="small"      ${c.typical_deal_size === 'small' ? 'selected' : ''}>Small ($5K to $25K ACV)</option>
                  <option value="mid"        ${c.typical_deal_size === 'mid' ? 'selected' : ''}>Mid-market ($25K to $100K ACV)</option>
                  <option value="large"      ${c.typical_deal_size === 'large' ? 'selected' : ''}>Large ($100K+ ACV)</option>
                  <option value="enterprise" ${c.typical_deal_size === 'enterprise' ? 'selected' : ''}>Enterprise ($250K+ ACV)</option>
                </select>
              </div>

              <div class="form-group">
                <label class="form-label">Sales motion</label>
                <select class="form-input" id="ob-sales-motion">
                  <option value=""       ${!c.sales_motion ? 'selected' : ''}>Select</option>
                  <option value="plg"    ${c.sales_motion === 'plg' ? 'selected' : ''}>PLG (product-led / self-serve)</option>
                  <option value="slg"    ${c.sales_motion === 'slg' ? 'selected' : ''}>SLG (sales-led)</option>
                  <option value="hybrid" ${c.sales_motion === 'hybrid' ? 'selected' : ''}>Hybrid (PLG + SLG)</option>
                </select>
              </div>
            </div>

            <div class="onboarding-actions">
              <button type="button" class="btn btn-ghost" onclick="Onboarding.skipAll()">Skip for now</button>
              <button type="submit" class="btn btn-primary" id="ob-submit">Save and continue</button>
            </div>
          </form>
        </div>
      </div>
    `;
  },

  async submitStep1() {
    const btn = el('ob-submit');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const payload = {
      company_name:      el('ob-company-name').value.trim(),
      what_we_sell:      el('ob-what-we-sell').value.trim(),
      target_icp:        el('ob-target-icp').value.trim(),
      our_positioning:   el('ob-our-positioning').value.trim(),
      typical_deal_size: el('ob-deal-size').value || null,
      sales_motion:      el('ob-sales-motion').value || null,
    };

    try {
      await API.saveUserContext(payload);
      try { localStorage.removeItem('cs-ctx-banner-dismissed'); } catch (_) {}
      Onboarding._context = { ...Onboarding._context, ...payload };
      Onboarding._step = 2;
      Onboarding._draw();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Save and continue';
      toast(e.message, 'error');
    }
  },

  // ── Step 2: voice profile ────────────────────────────────────────────────

  htmlStep2(v) {
    const radio = (name, value, label, helper) => `
      <label class="voice-radio">
        <input type="radio" name="${name}" value="${value}" ${v[name] === value ? 'checked' : ''} />
        <span class="voice-radio-body">
          <span class="voice-radio-label">${label}</span>
          ${helper ? `<span class="voice-radio-helper">${helper}</span>` : ''}
        </span>
      </label>`;

    return `
      <div class="onboarding-wrap">
        <div class="onboarding-card">
          <div class="onboarding-step-indicator">
            <span class="onboarding-step onboarding-step--done">✓</span>
            <span class="onboarding-step-bar onboarding-step-bar--done"></span>
            <span class="onboarding-step onboarding-step--active">2</span>
            <span class="onboarding-step-bar"></span>
            <span class="onboarding-step">3</span>
            <span class="onboarding-step-label">Step 2 of 3 · Voice profile (optional)</span>
          </div>

          <div class="onboarding-header">
            <div class="onboarding-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            </div>
            <div>
              <h2 class="onboarding-title">Tell us about your voice</h2>
              <p class="onboarding-sub">Optional. Helps us write outreach messages that sound like you, not like a chatbot. Skip this and we'll use sensible defaults.</p>
            </div>
          </div>

          <form id="voice-form" class="onboarding-form" onsubmit="event.preventDefault(); Onboarding.submitStep2();">

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
              <textarea class="form-input form-textarea" id="ob-signoff" rows="3" maxlength="1000"
                placeholder="Cheers,&#10;Eddy&#10;&#10;or&#10;&#10;Thanks!&#10;-E">${esc(v.sign_off_examples || '')}</textarea>
              <span class="form-hint">How do you usually sign off? Paste 2-3 examples. The AI will mirror these instead of inventing closers.</span>
            </div>

            <div class="form-group">
              <label class="form-label">Voice sample</label>
              <textarea class="form-input form-textarea" id="ob-voice-sample" rows="6" maxlength="4000"
                placeholder="Paste 1-2 short examples of emails you've written.">${esc(v.voice_sample || '')}</textarea>
              <span class="form-hint">Optional but powerful. The AI studies your phrasing, rhythm, and word choice to write like you.</span>
            </div>

            <div class="form-group">
              <label class="form-label">Phrases to avoid</label>
              <textarea class="form-input form-textarea" id="ob-avoid" rows="3" maxlength="1000"
                placeholder="delve, leverage, synergy, circle back, I hope this email finds you well">${esc(v.avoid_phrases || '')}</textarea>
              <span class="form-hint">Words or phrases you hate. Comma-separated. Anything you list here will never appear in your outreach.</span>
            </div>

            <div class="onboarding-actions">
              <button type="button" class="btn btn-ghost" onclick="Onboarding.skipStep2()">Skip, use defaults</button>
              <button type="submit" class="btn btn-primary" id="voice-submit">Save and finish</button>
            </div>
          </form>
        </div>
      </div>
    `;
  },

  async submitStep2() {
    const btn = el('voice-submit');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const getRadio = (name) => {
      const checked = document.querySelector(`input[name="${name}"]:checked`);
      return checked ? checked.value : null;
    };

    const payload = {
      formality:         getRadio('formality'),
      contraction_style: getRadio('contraction_style'),
      opener_style:      getRadio('opener_style'),
      sentence_rhythm:   getRadio('sentence_rhythm'),
      sign_off_examples: el('ob-signoff').value.trim(),
      voice_sample:      el('ob-voice-sample').value.trim(),
      avoid_phrases:     el('ob-avoid').value.trim(),
    };

    // Strip nulls so we don't submit empty enums — saveVoiceProfile accepts
    // null to clear, but for first-save we want to leave unselected fields
    // alone so defaults kick in.
    for (const k of Object.keys(payload)) {
      if (payload[k] === null || payload[k] === '') delete payload[k];
    }

    if (Object.keys(payload).length === 0) {
      // User skipped everything — same as the explicit Skip button.
      return Onboarding.skipStep2();
    }

    try {
      await API.saveVoiceProfile(payload);
      toast('Voice profile saved. Your outreach will sound like you.', 'success');
      Onboarding._step = 3;
      Onboarding._draw();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Save and finish';
      toast(e.message, 'error');
    }
  },

  skipStep2() {
    Onboarding._step = 3;
    Onboarding._draw();
  },

  // ── Step 3: win/loss + ROI (optional) ────────────────────────────────────
  htmlStep3() {
    return `
      <div class="onboarding-wrap">
        <div class="onboarding-card">
          <div class="onboarding-step-indicator">
            <span class="onboarding-step onboarding-step--done">✓</span>
            <span class="onboarding-step-bar onboarding-step-bar--done"></span>
            <span class="onboarding-step onboarding-step--done">✓</span>
            <span class="onboarding-step-bar onboarding-step-bar--done"></span>
            <span class="onboarding-step onboarding-step--active">3</span>
            <span class="onboarding-step-label">Step 3 of 3 · Track win/loss (optional)</span>
          </div>

          <div class="onboarding-header">
            <div class="onboarding-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            </div>
            <div>
              <h2 class="onboarding-title">Measure what competitors cost you</h2>
              <p class="onboarding-sub">Log your win/loss outcomes and tag the competitor on each loss. Foresight lines those losses up against what each competitor changed in the 30 days before the deal closed, then turns it into estimated revenue at risk. Logging a deal takes about ten seconds, in-app or via a Slack command.</p>
            </div>
          </div>

          <div class="onboarding-actions">
            <button type="button" class="btn btn-ghost" onclick="Onboarding.finishOnboarding()">Skip for now</button>
            <button type="button" class="btn btn-primary" onclick="navigate('/deals')">Set up Deals</button>
          </div>
        </div>
      </div>
    `;
  },

  finishOnboarding() {
    toast('You are all set. Log a deal any time from Deals & ROI.', 'success');
    navigate('/');
  },

  skipAll() {
    try { localStorage.setItem('cs-ctx-banner-dismissed', String(Date.now())); } catch (_) {}
    toast('Skipped. You can add context any time from Settings.', 'info');
    navigate('/');
  },
};
window.Onboarding = Onboarding;
