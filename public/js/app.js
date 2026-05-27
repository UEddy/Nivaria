// ─── Skeleton Templates ────────────────────────────────────────────────────────
const Skeleton = {
  dashboard: () => `
    <div class="skel-wrap">
      <div class="skel-stats">
        <div class="skeleton skel-stat"></div>
        <div class="skeleton skel-stat"></div>
        <div class="skeleton skel-stat"></div>
        <div class="skeleton skel-stat"></div>
      </div>
      <div class="skel-grid">
        <div class="skeleton skel-card-a"></div>
        <div class="skeleton skel-card-b"></div>
      </div>
    </div>`,
  table: () => `
    <div class="skel-wrap">
      <div class="skeleton skel-hdr"></div>
      <div class="skeleton skel-full"></div>
    </div>`,
  cards: (n = 4) => `
    <div class="skel-wrap">
      <div class="skeleton skel-hdr"></div>
      <div class="skel-rows">${Array(n).fill('<div class="skeleton skel-row"></div>').join('')}</div>
    </div>`,
};

// ─── Theme System ──────────────────────────────────────────────────────────────

const Theme = {
  key: 'cs-theme',

  init() {
    const saved = localStorage.getItem(Theme.key) || 'dark';
    Theme.apply(saved);
    Theme.wireBtns();

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if ((localStorage.getItem(Theme.key) || 'dark') === 'system') Theme.apply('system');
    });
  },

  apply(val) {
    const root = document.documentElement;
    if (val === 'system') {
      root.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    } else {
      root.setAttribute('data-theme', val);
    }
    localStorage.setItem(Theme.key, val);
    Theme.wireBtns();
  },

  wireBtns() {
    const saved = localStorage.getItem(Theme.key) || 'dark';
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === saved);
    });
  },
};

document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => Theme.apply(btn.dataset.val));
});

// ─── Avatar utility ────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  ['#6366F1','#4F46E5'], ['#06B6D4','#0891B2'], ['#10B981','#059669'],
  ['#F59E0B','#D97706'], ['#EF4444','#DC2626'], ['#A855F7','#9333EA'],
  ['#EC4899','#DB2777'], ['#14B8A6','#0D9488'],
];

function avatarHtml(name, size = 36) {
  const initials = (name || '?').trim().split(/\s+/).map(w => w[0]).join('').substring(0, 2).toUpperCase();
  const idx = [...(name || 'A')].reduce((acc, c) => acc + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  const [from, to] = AVATAR_COLORS[idx];
  return `<div class="comp-avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;background:linear-gradient(135deg,${from},${to})">${initials}</div>`;
}

// ─── Animated counter ─────────────────────────────────────────────────────────

function animateCounter(element, target, duration = 900) {
  const start = performance.now();
  const isFloat = target % 1 !== 0;
  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(target * ease);
    element.textContent = isFloat ? current.toFixed(0) : current;
    if (progress < 1) requestAnimationFrame(tick);
    else element.textContent = isFloat ? target.toFixed(0) : target;
  }
  requestAnimationFrame(tick);
}

// ─── App — router, state, utilities ───────────────────────────────────────────

const App = {
  user:      null,
  stats:     null,
  csrfToken: null, // populated from /api/auth/me; sent as X-CSRF-Token on mutations

  async init() {
    Theme.init();

    try {
      [App.user, App.stats] = await Promise.all([API.getMe(), API.getStats()]);
    } catch (e) {
      console.warn('Init fetch failed:', e.message);
    }

    // If getMe returned null (redirect in progress), stop here
    if (!App.user) return;

    // Store CSRF token for all subsequent mutation requests (see api.js)
    if (App.user.csrfToken) {
      App.csrfToken = App.user.csrfToken;
      delete App.user.csrfToken; // keep user object clean
    }

    App.updateUserUI();
    App.updateBadges();
    window.addEventListener('hashchange', App.route);
    App.route();
  },

  updateUserUI() {
    const u = App.user;
    if (!u) return;
    el('user-name').textContent = u.name;
    el('user-email').textContent = u.email;
    el('user-avatar').textContent = u.name?.[0]?.toUpperCase() || 'U';
    el('plan-name').textContent = { free: 'Free Plan', pro: 'Pro Plan', team: 'Team Plan' }[u.tier] || u.tier;

    const chip = el('plan-chip');
    if (chip) {
      chip.className = 'plan-chip plan-chip--' + (u.tier || 'free');
    }
  },

  async logout() {
    try { await API.logout(); } catch (_) {}
    window.location.href = '/login?loggedout=1';
  },

  updateBadges() {
    const s = App.stats;
    if (!s) return;
    const cc = el('nav-competitor-count');
    const ac = el('nav-alert-count');
    if (cc) cc.textContent = s.total_competitors || '';
    if (ac) ac.textContent = s.high_threats > 0 ? s.high_threats : '';
  },

  route() {
    // A hash fragment can carry a query string (e.g. /app#/settings?calendar_connected=google
    // landing from the OAuth callback). Split path from query before parsing,
    // and pass the parsed query down to renders that opt in. Without this
    // split, "settings?calendar_connected=google" was treated as a page name
    // and fell through to the 404 branch.
    const rawHash = (window.location.hash || '#').slice(1) || '/';
    const qIdx = rawHash.indexOf('?');
    const pathPart  = qIdx === -1 ? rawHash : rawHash.slice(0, qIdx);
    const queryStr  = qIdx === -1 ? ''      : rawHash.slice(qIdx + 1);
    const routeQuery = new URLSearchParams(queryStr);

    const [base, ...rest] = pathPart.split('/').filter(Boolean);
    const page = base || 'dashboard';

    document.querySelectorAll('.nav-item').forEach(a => {
      const p = a.dataset.page;
      a.classList.toggle('active', p === page
        || (p === 'dashboard' && page === '')
        || (p === 'deals' && page === 'roi')); // ROI route highlights the Deals nav item
    });

    const root = el('page-root');
    el('topbar-actions').innerHTML = '';

    const id = rest[0];
    const transition = () => window.pageTransitionIn?.(root);

    if (page === '' || page === 'dashboard') {
      el('page-title').textContent = 'Dashboard';
      el('page-sub').textContent = 'Your competitive intelligence overview';
      root.innerHTML = Skeleton.dashboard();
      Dashboard.render().then(transition);
    } else if (page === 'competitors') {
      if (id) {
        el('page-title').textContent = 'Competitor Timeline';
        el('page-sub').textContent = 'All detected changes for this competitor';
        root.innerHTML = Skeleton.cards(5);
        CompetitorDetail.render(id).then(transition);
      } else {
        el('page-title').textContent = 'Competitors';
        el('page-sub').textContent = 'Manage the pages you track';
        root.innerHTML = Skeleton.table();
        Competitors.render().then(transition);
      }
    } else if (page === 'history') {
      if (id) {
        el('page-title').textContent = 'Brief';
        el('page-sub').textContent = 'Detailed competitive analysis';
        root.innerHTML = Skeleton.cards(5);
        BattleCard.render(id).then(transition);
      } else {
        el('page-title').textContent = 'Change Feed';
        el('page-sub').textContent = 'All detected changes, analyzed by AI';
        root.innerHTML = Skeleton.cards(6);
        History.render().then(transition);
      }
    } else if (page === 'deals') {
      if (id) {
        el('page-title').textContent = 'Deal';
        el('page-sub').textContent = 'Outcome and competitor activity at close';
        root.innerHTML = Skeleton.cards(3);
        Deals.renderDetail(id).then(transition);
      } else {
        el('page-title').textContent = 'Deals & ROI';
        el('page-sub').textContent = 'Log win/loss outcomes and see what they cost you';
        root.innerHTML = Skeleton.cards(4);
        Deals.render(routeQuery).then(transition);
      }
    } else if (page === 'roi') {
      // ROI lives as a tab inside the Deals page; this route opens it directly.
      el('page-title').textContent = 'Deals & ROI';
      el('page-sub').textContent = 'Estimated revenue impact of competitor activity';
      root.innerHTML = Skeleton.cards(4);
      routeQuery.set('tab', 'roi');
      Deals.render(routeQuery).then(transition);
    } else if (page === 'settings') {
      el('page-title').textContent = 'Settings';
      el('page-sub').textContent = 'Webhooks, notifications, and account';
      root.innerHTML = Skeleton.cards(4);
      Settings.render(routeQuery).then(transition);
    } else if (page === 'pricing') {
      el('page-title').textContent = 'Plans & Pricing';
      el('page-sub').textContent = 'Choose the plan that fits your team';
      root.innerHTML = Skeleton.cards(3);
      Pricing.render(); transition();
    } else if (page === 'onboarding') {
      el('page-title').textContent = 'Welcome to Foresight';
      el('page-sub').textContent = 'One quick step to personalize your analyses';
      root.innerHTML = Skeleton.cards(3);
      Onboarding.render().then(transition);
    } else {
      root.innerHTML = `<div class="empty-state">
        <div class="empty-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </div>
        <div class="empty-title">Page not found</div>
        <div class="empty-desc">The page you're looking for doesn't exist.</div>
        <a class="btn btn-primary" href="#/">Go to Dashboard</a>
      </div>`;
      transition();
    }
  },
};
window.App = App;

// ─── Utilities ─────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function formatShortDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function threatBadge(level) {
  if (!level) return '';
  return `<span class="badge badge-${level}">${level.toUpperCase()}</span>`;
}

function openModal(contentHtml, wide = false) {
  el('modal-content').innerHTML = contentHtml;
  const box = el('modal-box');
  box.style.maxWidth = wide ? '760px' : '540px';
  el('modal-overlay').classList.add('open');
}

function closeModal(e) {
  if (!e || e.target === el('modal-overlay')) {
    el('modal-overlay').classList.remove('open');
    el('modal-content').innerHTML = '';
  }
}
window.closeModal = closeModal;

function toast(msg, type = 'info') {
  const icons = { success: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`, error: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`, info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` };
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${esc(msg)}</span>`;
  el('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 4100);
}

function navigate(path) {
  window.location.hash = path;
}

// ─── Pricing page ─────────────────────────────────────────────────────────────
const Pricing = {
  render() {
    const plans = [
      {
        id: 'free', name: 'Free', price: 0, desc: 'Try it out, no credit card needed',
        features: ['1 competitor URL', 'Manual checks only', 'Basic AI briefs', 'Community support'],
      },
      {
        id: 'pro', name: 'Pro', price: 20, desc: 'For growing competitive teams',
        features: ['10 competitor URLs', 'Automatic daily checks', 'Slack & Discord alerts', 'Full AI briefs', 'Priority email support'],
        popular: true,
      },
      {
        id: 'team', name: 'Team', price: 49, desc: 'For sales-led organizations',
        features: ['Unlimited competitor URLs', 'Automatic daily checks', 'Multiple webhooks', 'Team dashboard', 'API access', 'Dedicated support'],
      },
    ];

    const current = App.user?.tier || 'free';

    el('page-root').innerHTML = `
      <div class="pricing-wrap">
        <div class="pricing-intro">
          <p class="text-muted">You're on the <strong style="color:var(--txt)">${current.charAt(0).toUpperCase() + current.slice(1)}</strong> plan. Switch plans below to test tier enforcement.</p>
        </div>
        <div class="pricing-grid">
          ${plans.map(p => `
            <div class="pricing-card ${p.popular ? 'featured' : ''}">
              ${p.popular ? '<div class="pricing-popular">Most Popular</div>' : ''}
              <div class="pricing-header">
                <div class="pricing-plan">${p.name}</div>
                <div class="pricing-price">
                  <span class="price-amount">$${p.price}</span>
                  <span class="price-period">/mo</span>
                </div>
                <div class="pricing-desc">${p.desc}</div>
              </div>
              <ul class="pricing-features">
                ${p.features.map(f => `<li class="pricing-feature">${esc(f)}</li>`).join('')}
              </ul>
              <button
                class="btn ${p.id === current ? 'btn-secondary' : 'btn-primary'} w-full"
                ${p.id === current ? 'disabled' : ''}
                onclick="Pricing.switchTier('${p.id}')"
              >
                ${p.id === current ? '✓ Current Plan' : p.price === 0 ? 'Downgrade to Free' : 'Upgrade to ' + p.name}
              </button>
            </div>
          `).join('')}
        </div>
        <p class="text-muted text-sm" style="text-align:center;margin-top:24px">
          Stripe payments coming soon. Buttons above simulate plan switching for demo.
        </p>
      </div>
    `;
  },

  async switchTier(tier) {
    try {
      await API.setTier(tier);
      App.user.tier = tier;
      App.updateUserUI();
      toast(`Switched to ${tier} plan`, 'success');
      Pricing.render();
    } catch (e) {
      toast(e.message, 'error');
    }
  },
};
window.Pricing = Pricing;

document.addEventListener('DOMContentLoaded', () => App.init());
