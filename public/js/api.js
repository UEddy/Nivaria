// API client — all fetch calls go through here
const API = (() => {
  const base = '/api';

  async function request(method, path, body, reqOpts = {}) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };

    // Attach CSRF token to all state-changing requests.
    // App.csrfToken is populated by App.init() after getMe() succeeds.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const token = window.App?.csrfToken;
      if (token) opts.headers['X-CSRF-Token'] = token;
    }

    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(base + path, opts);

    // Fresh-auth endpoints (account delete/cancel) return 401 on a wrong
    // password — those callers pass silent401 so we don't bounce to /login.
    if (res.status === 401 && !reqOpts.silent401) {
      window.location.href = '/login?expired=1';
      return;
    }

    const data = await res.json().catch(() => ({}));

    // Phase 10: a 402 upgrade_required from any gated endpoint shows the upgrade
    // modal centrally — the backend owns the message + upgradeUrl, the frontend
    // just renders. The call still rejects so the caller can stop its flow.
    if (res.status === 402 && data && data.error === 'upgrade_required' && !reqOpts.noGateModal) {
      try { window.showUpgradeModal && window.showUpgradeModal(data); } catch (_) {}
    }

    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), data);
    return data;
  }

  return {
    get:    (path)        => request('GET',    path),
    post:   (path, body)  => request('POST',   path, body),
    put:    (path, body)  => request('PUT',    path, body),
    delete: (path, body)  => request('DELETE', path, body),

    // Auth
    getMe:   ()     => API.get('/auth/me'),
    setTier: (tier) => API.put('/auth/me/tier', { tier }),
    logout:  ()     => API.post('/auth/logout'),

    // Phase 10 — billing. State is webhook-driven server-side.
    getSubscription:     ()           => API.get('/billing/subscription'),
    checkout:            (tier='pro') => API.post('/billing/checkout', { tier }),
    billingPortal:       ()           => API.post('/billing/portal'),
    cancelSubscription:  ()           => API.post('/billing/cancel'),
    resumeSubscription:  ()           => API.post('/billing/resume'),
    reconcile:           ()           => API.post('/billing/reconcile'),

    // Phase 10 — waitlist (Team/Business). Public endpoint.
    joinWaitlist: (data) => API.post('/waitlist', data),

    // Phase 10 — GDPR account rights. delete/cancel use fresh-auth (password),
    // so a wrong password must NOT redirect to /login (silent401). Delete is an
    // immediate hard delete and additionally requires a typed-email confirmation.
    deleteAccount:  (password, confirmEmail) => request('POST', '/account/delete', { password, confirmEmail }, { silent401: true }),
    cancelDeletion: (password) => request('POST', '/account/delete/cancel', { password }, { silent401: true }),

    // Profile (friendly name + timezone) + first-visit flag.
    updateProfile:        (data) => API.put('/account/profile', data),
    markDashboardVisited: ()     => API.post('/account/dashboard-visited'),

    // Stats
    getStats: () => API.get('/changes/stats'),

    // Competitors
    getCompetitors:   ()           => API.get('/competitors'),
    getCompetitor:    (id)         => API.get(`/competitors/${id}`),
    addCompetitor:    (data)       => API.post('/competitors', data),
    updateCompetitor: (id, data)   => API.put(`/competitors/${id}`, data),
    deleteCompetitor: (id)         => API.delete(`/competitors/${id}`),
    toggleCompetitor: (id)         => API.put(`/competitors/${id}/toggle`),
    checkCompetitor:  (id)         => API.post(`/competitors/${id}/check`),
    getCompetitorHistory:  (id)    => API.get(`/competitors/${id}/history`),
    getCompetitorPatterns: (id)    => API.get(`/competitors/${id}/patterns`),

    // Changes
    getChanges: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return API.get(`/changes${qs ? '?' + qs : ''}`);
    },
    getChange: (id) => API.get(`/changes/${id}`),

    // Settings
    getSettings:  ()          => API.get('/settings'),
    saveSettings: (data)      => API.put('/settings', data),
    testWebhook:  (type, url) => API.post('/settings/test-webhook', { type, url }),

    // User business context (Phase 6)
    getUserContext: ()        => API.get('/user/context'),
    saveUserContext: (data)   => API.put('/user/context', data),

    // Voice profile + outreach playbooks (Phase 8)
    getVoiceProfile:        ()                => API.get('/user/voice-profile'),
    saveVoiceProfile:       (data)            => API.put('/user/voice-profile', data),
    getPlaybooksForChange:  (changeId)        => API.get(`/playbooks/changes/${changeId}`),
    generatePlaybooks:      (changeId)        => API.post(`/playbooks/changes/${changeId}/generate`),
    regeneratePlaybook:     (playbookId)      => API.post(`/playbooks/${playbookId}/regenerate`),
    getRecentPlaybooks:     (limit = 5)       => API.get(`/playbooks/recent?limit=${limit}`),

    // Win/loss deals + Revenue Impact Dashboard (Phase 9)
    getDeals:        (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return API.get(`/deals${qs ? '?' + qs : ''}`);
    },
    getDeal:         (id)          => API.get(`/deals/${id}`),
    createDeal:      (data)        => API.post('/deals', data),
    updateDeal:      (id, data)    => API.put(`/deals/${id}`, data),
    deleteDeal:      (id)          => API.delete(`/deals/${id}`),
    getDealNames:    (q = '')      => API.get(`/deals/autocomplete?q=${encodeURIComponent(q)}`),
    getRoi:          ()            => API.get('/roi'),
    getRoiSummary:   ()            => API.get('/roi/summary'),
    createPatternAlert: (competitorId, patternType) => API.post('/roi/alerts', { competitor_id: competitorId, pattern_type: patternType }),
    removePatternAlert: (competitorId, patternType) => API.delete('/roi/alerts', { competitor_id: competitorId, pattern_type: patternType }),

    // Slack integration (Phase 9)
    getSlackConnection: () => API.get('/slack/connection'),
    disconnectSlack:    () => API.post('/slack/oauth/disconnect'),

    // Calendar / pre-meeting briefings (Phase 7)
    getCalendarConnections:    ()           => API.get('/calendar/connections'),
    disconnectCalendar:        (provider)   => API.post(`/calendar/${provider}/disconnect`),
    getUpcomingMeetings:       ()           => API.get('/calendar/meetings/upcoming'),
    getMeetingsByCompetitor:   (id)         => API.get(`/calendar/meetings/by-competitor/${id}`),
    tagMeeting:                (id, competitorId) => API.put(`/calendar/meetings/${id}/tag`, { competitor_id: competitorId }),
    triggerCalendarSync:       ()           => API.post('/calendar/sync-now'),
  };
})();
window.API = API;
