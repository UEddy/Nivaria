// API client — all fetch calls go through here
const API = (() => {
  const base = '/api';

  async function request(method, path, body) {
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

    if (res.status === 401) {
      window.location.href = '/login?expired=1';
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), data);
    return data;
  }

  return {
    get:    (path)        => request('GET',    path),
    post:   (path, body)  => request('POST',   path, body),
    put:    (path, body)  => request('PUT',    path, body),
    delete: (path)        => request('DELETE', path),

    // Auth
    getMe:   ()     => API.get('/auth/me'),
    setTier: (tier) => API.put('/auth/me/tier', { tier }),
    logout:  ()     => API.post('/auth/logout'),

    // Stats
    getStats: () => API.get('/changes/stats'),

    // Competitors
    getCompetitors:   ()           => API.get('/competitors'),
    addCompetitor:    (data)       => API.post('/competitors', data),
    updateCompetitor: (id, data)   => API.put(`/competitors/${id}`, data),
    deleteCompetitor: (id)         => API.delete(`/competitors/${id}`),
    toggleCompetitor: (id)         => API.put(`/competitors/${id}/toggle`),
    checkCompetitor:  (id)         => API.post(`/competitors/${id}/check`),

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
  };
})();
window.API = API;
