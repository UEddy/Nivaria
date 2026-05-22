// Phase 6 — onboarding form.
//
// Routes:
//   #/onboarding         → first-time setup (after register/verify)
//   #/onboarding?from=settings → user opened it from the dashboard banner
//
// All fields are optional; the user can "Skip for now" and land at the
// dashboard. The banner on the dashboard will remind them later.

const Onboarding = {
  async render() {
    el('topbar-actions').innerHTML = '';

    let data;
    try {
      data = await API.getUserContext();
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Could not load onboarding</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
      return;
    }

    const c = data.context || {};
    el('page-root').innerHTML = Onboarding.html(c);
  },

  html(c) {
    return `
      <div class="onboarding-wrap">
        <div class="onboarding-card">
          <div class="onboarding-header">
            <div class="onboarding-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
            </div>
            <div>
              <h2 class="onboarding-title">Tell us about your business</h2>
              <p class="onboarding-sub">Foresight uses this context to write battle cards from your strategic perspective — your ICP, positioning, deal size — instead of a generic outside view. All fields are optional. You can edit any of this later in Settings.</p>
            </div>
          </div>

          <form id="onboarding-form" class="onboarding-form" onsubmit="event.preventDefault(); Onboarding.submit();">

            <div class="form-group">
              <label class="form-label">Company name</label>
              <input class="form-input" id="ob-company-name" maxlength="200"
                placeholder="What's your company called?" value="${esc(c.company_name || '')}" />
              <span class="form-hint">Shown on your battle cards as "Analyzed for: [your company]".</span>
            </div>

            <div class="form-group">
              <label class="form-label">What we sell</label>
              <textarea class="form-input form-textarea" id="ob-what-we-sell" rows="3" maxlength="5000"
                placeholder="Describe your product in 1–3 sentences.">${esc(c.what_we_sell || '')}</textarea>
              <span class="form-hint">Helps the AI understand what category you're in and what changes are competitive vs adjacent.</span>
            </div>

            <div class="form-group">
              <label class="form-label">Target ICP</label>
              <textarea class="form-input form-textarea" id="ob-target-icp" rows="3" maxlength="5000"
                placeholder="Who do you sell to? Industry, company size, and the typical role you sell to.">${esc(c.target_icp || '')}</textarea>
              <span class="form-hint">Lets the AI flag changes that hit your ICP harder than competitor moves in adjacent markets.</span>
            </div>

            <div class="form-group">
              <label class="form-label">Our positioning</label>
              <textarea class="form-input form-textarea" id="ob-our-positioning" rows="3" maxlength="5000"
                placeholder="How do you differentiate from competitors? Speed, price, depth, niche focus, etc.">${esc(c.our_positioning || '')}</textarea>
              <span class="form-hint">When a competitor moves toward your differentiator, the AI will treat that as a higher threat.</span>
            </div>

            <div class="form-row two-col">
              <div class="form-group">
                <label class="form-label">Typical deal size</label>
                <select class="form-input" id="ob-deal-size">
                  <option value=""           ${!c.typical_deal_size ? 'selected' : ''}>— Select —</option>
                  <option value="small"      ${c.typical_deal_size === 'small' ? 'selected' : ''}>Small ($5K–25K ACV)</option>
                  <option value="mid"        ${c.typical_deal_size === 'mid' ? 'selected' : ''}>Mid-market ($25K–100K ACV)</option>
                  <option value="large"      ${c.typical_deal_size === 'large' ? 'selected' : ''}>Large ($100K+ ACV)</option>
                  <option value="enterprise" ${c.typical_deal_size === 'enterprise' ? 'selected' : ''}>Enterprise ($250K+ ACV)</option>
                </select>
              </div>

              <div class="form-group">
                <label class="form-label">Sales motion</label>
                <select class="form-input" id="ob-sales-motion">
                  <option value=""       ${!c.sales_motion ? 'selected' : ''}>— Select —</option>
                  <option value="plg"    ${c.sales_motion === 'plg' ? 'selected' : ''}>PLG (product-led / self-serve)</option>
                  <option value="slg"    ${c.sales_motion === 'slg' ? 'selected' : ''}>SLG (sales-led)</option>
                  <option value="hybrid" ${c.sales_motion === 'hybrid' ? 'selected' : ''}>Hybrid (PLG + SLG)</option>
                </select>
              </div>
            </div>

            <div class="onboarding-actions">
              <button type="button" class="btn btn-ghost" onclick="Onboarding.skip()">Skip for now</button>
              <button type="submit" class="btn btn-primary" id="ob-submit">Save and continue</button>
            </div>
          </form>
        </div>
      </div>
    `;
  },

  async submit() {
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
      // Clear any cached dismissal so the banner doesn't reappear immediately
      try { localStorage.removeItem('cs-ctx-banner-dismissed'); } catch (_) {}
      toast('Business context saved — future analyses will reflect it', 'success');
      navigate('/');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Save and continue';
      toast(e.message, 'error');
    }
  },

  skip() {
    // Honor "Skip for now" — but mark the dismissal so the banner waits the
    // standard 14 days before reminding.
    try { localStorage.setItem('cs-ctx-banner-dismissed', String(Date.now())); } catch (_) {}
    toast('Skipped — you can add context any time from Settings', 'info');
    navigate('/');
  },
};
window.Onboarding = Onboarding;
