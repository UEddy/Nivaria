// Phase 10 — client-side billing: Lemon Squeezy overlay, upgrade-gate modal,
// Team/Business waitlist modals, and GDPR account controls. Subscription state
// is owned by the server (webhook-driven); this file only triggers flows and
// renders responses.

const X_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

const PRO_INCLUDES = [
  '10 competitors with automatic daily monitoring',
  'Slack & Discord alerts + calendar briefings',
  'AI outreach playbooks',
  'Win/loss correlation & historical pattern analysis',
];

// ── Lemon Squeezy overlay ──────────────────────────────────────────────────────
function initLemon() {
  if (window.__lemonInited) return;
  if (typeof window.createLemonSqueezy === 'function') window.createLemonSqueezy();
  if (window.LemonSqueezy && typeof window.LemonSqueezy.Setup === 'function') {
    window.LemonSqueezy.Setup({ eventHandler: onLemonEvent });
    window.__lemonInited = true;
  }
}

// lemon.js emits e.g. { event: 'Checkout.Success', data: {...} } (older builds
// used 'PaymentSuccess'); match any success signal defensively.
function onLemonEvent(event) {
  const name = (event && (event.event || event.type)) || '';
  if (/success/i.test(name)) {
    try { sessionStorage.setItem('cs-welcome-pro', '1'); } catch (_) {}
    try { window.LemonSqueezy?.Url?.Close?.(); } catch (_) {}
    toast('Welcome to Pro! 🎉', 'success');
    // Safety net: if the subscription_created webhook hasn't flipped the
    // workspace to Pro within 5s, reconcile directly against Lemon Squeezy so
    // the user never sits in a "paid but shows Free" state.
    setTimeout(async () => {
      try {
        const s = await API.getSubscription();
        if (s.effectiveTier !== 'pro') { try { await API.reconcile(); } catch (_) {} }
      } catch (_) {}
    }, 5000);
    // Give the webhook a beat, then land on the dashboard (welcome banner).
    setTimeout(() => { navigate('/'); }, 900);
  }
}

const Billing = {
  // Open the Pro checkout overlay. Used by the pricing page, Settings, and the
  // upgrade-gate modal. Backend returns a Lemon Squeezy checkout URL.
  async subscribe(btn) {
    const restore = btn ? startBtn(btn, 'Opening…') : null;
    try {
      const { checkoutUrl } = await API.checkout('pro');
      if (!checkoutUrl) throw new Error('No checkout URL returned');
      initLemon();
      if (window.LemonSqueezy?.Url?.Open) {
        window.LemonSqueezy.Url.Open(checkoutUrl);
      } else {
        // Overlay script blocked/unavailable — fall back to a hosted checkout tab.
        window.open(checkoutUrl, '_blank', 'noopener');
      }
    } catch (e) {
      if (e.error !== 'upgrade_required') toast(e.message || 'Could not start checkout', 'error');
    } finally {
      restore && restore();
    }
  },

  async openPortal(btn) {
    const restore = btn ? startBtn(btn, 'Opening…') : null;
    try {
      const { portalUrl } = await API.billingPortal();
      if (!portalUrl) throw new Error('No portal URL');
      window.location.href = portalUrl;
    } catch (e) {
      toast(e.message || 'Could not open the billing portal', 'error');
      restore && restore();
    }
  },

  confirmCancel() {
    openModal(`
      <div class="modal-header"><div class="modal-title">Cancel Pro?</div>
        <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
      <div class="modal-body"><p style="color:var(--txt-2);line-height:1.7">
        Your Pro features stay active until the end of the current billing period — you won't lose access immediately. You can resume any time before then.</p></div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Keep Pro</button>
        <button class="btn btn-danger" onclick="Billing.doCancel(this)">Cancel at period end</button>
      </div>`);
  },
  async doCancel(btn) {
    const restore = startBtn(btn, 'Cancelling…');
    try {
      await API.cancelSubscription();
      closeModal();
      toast('Cancellation scheduled. Pro stays active until your period ends.', 'success');
      if (window.Settings) Settings.render();
    } catch (e) { toast(e.message, 'error'); restore(); }
  },
  async resume(btn) {
    const restore = startBtn(btn, 'Resuming…');
    try {
      await API.resumeSubscription();
      toast('Subscription resumed.', 'success');
      if (window.Settings) Settings.render();
    } catch (e) { toast(e.message, 'error'); restore(); }
  },

  // ── Upgrade-gate modal (shown centrally on any 402 upgrade_required) ──────────
  upgradeFromGate() { closeModal(); Billing.subscribe(); },

  // Manual reconcile from Settings ("Subscription not showing correctly?").
  async reconcile(linkEl) {
    if (linkEl) linkEl.textContent = 'Checking…';
    try {
      const r = await API.reconcile();
      toast(r.reconciled ? 'Subscription synced from Lemon Squeezy.' : (r.message || 'Your subscription is already up to date.'),
        r.reconciled ? 'success' : 'info');
      if (window.Settings) Settings.render();
    } catch (e) {
      toast(e.message || 'Could not sync your subscription', 'error');
      if (linkEl) linkEl.textContent = 'Subscription not showing correctly?';
    }
  },

  // ── Waitlist (Team / Business) ────────────────────────────────────────────────
  openWaitlist(tier) {
    const isTeam = tier === 'team';
    const label = isTeam ? 'Team' : 'Business';
    const blurb = isTeam
      ? 'Team adds shared workspaces and multi-user seats. Launching soon — leave your email and we’ll notify you first.'
      : 'Business adds advanced monitoring, custom integrations, and dedicated support. Tell us about your use case and we’ll be in touch.';
    const field = isTeam
      ? `<div class="form-group">
           <label class="form-label" for="wl-size">Team size</label>
           <select class="form-input" id="wl-size">
             <option value="">Select…</option>
             <option value="3">1–5 people</option>
             <option value="10">6–15 people</option>
             <option value="30">16–50 people</option>
             <option value="75">50+ people</option>
           </select>
         </div>`
      : `<div class="form-group">
           <label class="form-label" for="wl-usecase">What would you use Nivaria for?</label>
           <textarea class="form-input form-textarea" id="wl-usecase" rows="4" maxlength="2000"
             placeholder="Industry, team size, special requirements."></textarea>
         </div>`;
    openModal(`
      <div class="modal-header"><div class="modal-title">Join the ${label} waitlist</div>
        <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
      <div class="modal-body" id="wl-body">
        <p style="color:var(--txt-3);font-size:13px;line-height:1.6;margin-bottom:4px">${blurb}</p>
        <div class="form-group">
          <label class="form-label" for="wl-email">Email</label>
          <input class="form-input" id="wl-email" type="email" inputmode="email" autocomplete="email"
            placeholder="you@company.com" value="${esc(App.user?.email || '')}" />
        </div>
        ${field}
      </div>
      <div class="modal-footer" id="wl-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="Billing.submitWaitlist('${tier}', this)">Notify me</button>
      </div>`);
  },

  async submitWaitlist(tier, btn) {
    const email = (el('wl-email')?.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Enter a valid email address', 'error');
    const payload = { email, tier };
    if (tier === 'team') {
      const v = el('wl-size')?.value;
      if (v) payload.teamSizeEstimate = parseInt(v, 10);
    } else {
      const uc = (el('wl-usecase')?.value || '').trim();
      if (uc) payload.useCase = uc;
    }
    const restore = startBtn(btn, 'Submitting…');
    try {
      const r = await API.joinWaitlist(payload);
      const label = tier === 'team' ? 'Team' : 'Business';
      const msg = r.alreadySignedUp
        ? `You’re already on the ${label} waitlist — we’ll be in touch.`
        : `You’re on the ${label} waitlist! We’ll email ${esc(email)} when it’s ready.`;
      el('wl-body').innerHTML = `
        <div class="wl-success">
          <div class="wl-success__icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div class="wl-success__text">${msg}</div>
        </div>`;
      const footer = el('wl-footer');
      if (footer) footer.innerHTML = `<button class="btn btn-primary" onclick="closeModal()">Done</button>`;
    } catch (e) {
      toast(e.message || 'Could not join the waitlist', 'error');
      restore();
    }
  },

  // ── GDPR ────────────────────────────────────────────────────────────────────
  exportData(btn) {
    toast('Preparing your data export…', 'info');
    // GET with the session cookie; Content-Disposition triggers the download.
    window.location.href = '/api/account/export';
  },

  confirmDeleteAccount() {
    openModal(`
      <div class="modal-header"><div class="modal-title">Delete account</div>
        <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
      <div class="modal-body" id="del-body">
        <p style="color:var(--txt-2);line-height:1.7">This schedules permanent deletion of your account and all workspace data in <strong>30 days</strong>. We’ll email you a cancellation link — you can undo it any time before then.</p>
        <div class="form-group">
          <label class="form-label" for="del-pw">Confirm your password to continue</label>
          <input class="form-input" id="del-pw" type="password" autocomplete="current-password" placeholder="Your password" />
          <span class="form-hint" id="del-err" style="color:var(--red)"></span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Keep my account</button>
        <button class="btn btn-danger" onclick="Billing.doDeleteAccount(this)">Delete my account</button>
      </div>`);
  },
  async doDeleteAccount(btn) {
    const pw = el('del-pw')?.value || '';
    const errEl = el('del-err');
    if (errEl) errEl.textContent = '';
    if (!pw) { if (errEl) errEl.textContent = 'Password is required.'; return; }
    const restore = startBtn(btn, 'Processing…');
    try {
      const r = await API.deleteAccount(pw);
      el('del-body').innerHTML = `
        <div class="wl-success">
          <div class="wl-success__icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div class="wl-success__text">${esc(r.message || 'Deletion scheduled.')} Check your email for the cancellation link.</div>
        </div>`;
      const f = btn.closest('.modal-footer');
      if (f) f.innerHTML = `<button class="btn btn-primary" onclick="closeModal()">Done</button>`;
    } catch (e) {
      if (errEl) errEl.textContent = e.message || 'Could not process the request.';
      restore();
    }
  },
};
window.Billing = Billing;

// Central upgrade-gate modal — invoked by api.js on any 402 upgrade_required.
function showUpgradeModal(info) {
  const message = (info && info.message) || 'This is a Pro feature.';
  openModal(`
    <div class="modal-header"><div class="modal-title">Upgrade to Pro</div>
      <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
    <div class="modal-body">
      <p style="color:var(--txt);font-size:14.5px;font-weight:600;margin-bottom:10px">${esc(message)}</p>
      <ul class="upgrade-list">
        ${PRO_INCLUDES.map(f => `<li>${esc(f)}</li>`).join('')}
      </ul>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Maybe later</button>
      <button class="btn btn-primary" onclick="Billing.upgradeFromGate()">Upgrade — $20/month</button>
    </div>`);
}
window.showUpgradeModal = showUpgradeModal;

// Small helper: disable a button + show a transient label, returning a restore fn.
function startBtn(btn, label) {
  if (!btn) return () => {};
  const orig = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = label;
  return () => { btn.disabled = wasDisabled; btn.innerHTML = orig; };
}
window.startBtn = startBtn;
