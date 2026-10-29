// Account controls: GDPR data export and account deletion, plus the plan-limit
// notice shown when the server answers 403 plan_limit. There is no billing:
// every account is on one fixed plan (src/lib/tierLimits.js), so the notice
// explains the limit and offers nothing to buy.

const X_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

const Account = {
  exportData() {
    toast('Preparing your data export…', 'info');
    // GET with the session cookie; Content-Disposition triggers the download.
    window.location.href = '/api/account/export';
  },

  confirmDeleteAccount() {
    const email = (window.App && App.user && App.user.email) || '';
    openModal(`
      <div class="modal-header"><div class="modal-title">Delete your Nivaria account?</div>
        <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
      <div class="modal-body" id="del-body">
        <p style="color:var(--txt-2);line-height:1.6;margin-bottom:10px">This is <strong style="color:var(--red-2)">immediate and permanent</strong>. There is no recovery. The following are erased:</p>
        <ul class="del-list">
          <li>Your account and login credentials</li>
          <li>All competitors and briefs you've created</li>
          <li>Your workspace and all associated data</li>
          <li>Calendar and Slack integrations</li>
        </ul>
        <div class="form-group">
          <label class="form-label" for="del-email">Type your email address to confirm</label>
          <input class="form-input" id="del-email" type="email" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${esc(email)}" oninput="Account._syncDeleteBtn()" />
        </div>
        <div class="form-group">
          <label class="form-label" for="del-pw">Confirm your password</label>
          <input class="form-input" id="del-pw" type="password" autocomplete="current-password" placeholder="Your password" oninput="Account._syncDeleteBtn()" />
          <span class="form-hint" id="del-err" style="color:var(--red)"></span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" id="del-confirm-btn" onclick="Account.doDeleteAccount(this)" disabled>Delete Account Permanently</button>
      </div>`);
  },

  // The confirm button stays disabled until the typed email matches the account
  // email (case-insensitive) AND a password has been entered.
  _syncDeleteBtn() {
    const btn = el('del-confirm-btn');
    if (!btn) return;
    const accountEmail = ((window.App && App.user && App.user.email) || '').trim().toLowerCase();
    const typed = (el('del-email')?.value || '').trim().toLowerCase();
    const pw    = el('del-pw')?.value || '';
    btn.disabled = !(accountEmail && typed === accountEmail && pw.length > 0);
  },

  async doDeleteAccount(btn) {
    const confirmEmail = (el('del-email')?.value || '').trim();
    const pw = el('del-pw')?.value || '';
    const errEl = el('del-err');
    if (errEl) errEl.textContent = '';
    if (!confirmEmail || !pw) { if (errEl) errEl.textContent = 'Type your email and password to continue.'; return; }
    const restore = startBtn(btn, 'Deleting…');
    try {
      const r = await API.deleteAccount(pw, confirmEmail);
      el('del-body').innerHTML = `
        <div class="wl-success">
          <div class="wl-success__icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div class="wl-success__text">${esc(r.message || 'Your account has been permanently deleted.')}</div>
        </div>`;
      const f = btn.closest('.modal-footer');
      if (f) f.innerHTML = '';
      // The session is already destroyed server-side; land on the landing page.
      setTimeout(() => { window.location.href = (r && r.redirect) || '/'; }, 1400);
    } catch (e) {
      if (errEl) errEl.textContent = e.message || 'Could not process the request.';
      restore();
    }
  },
};
window.Account = Account;

// Shown centrally by api.js on any 403 plan_limit. The server owns the message.
function showPlanLimitModal(info) {
  const message = (info && info.message) || 'You’ve reached a limit of your plan.';
  openModal(`
    <div class="modal-header"><div class="modal-title">Plan limit reached</div>
      <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
    <div class="modal-body">
      <p style="color:var(--txt);font-size:14.5px;line-height:1.6">${esc(message)}</p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-primary" onclick="closeModal()">OK</button>
    </div>`);
}
window.showPlanLimitModal = showPlanLimitModal;

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
