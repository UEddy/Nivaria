/* Landing page: navbar, mobile menu, scroll reveals, the "How it works" tabs,
   the decorative dot maps and the one-click live demo. */

(function () {
  // ── Theme ────────────────────────────────────────────────────────────────
  // Same saved choice as the app (localStorage cs-theme: light, dark or
  // system; dark when unset). The inline script in <head> applies it before
  // first paint; this keeps it in sync and wires the toggle.
  const THEME_KEY = 'cs-theme';
  function savedTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (_) { return 'dark'; }
  }
  function resolve(val) {
    return val === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : val;
  }
  function applyTheme(val) {
    const theme = resolve(val);
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('lp-theme-btn');
    if (btn) btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#000000');
  }
  function initTheme() {
    applyTheme(savedTheme());
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (savedTheme() === 'system') applyTheme('system');
    });
    const btn = document.getElementById('lp-theme-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = resolve(savedTheme()) === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
      applyTheme(next);
    });
  }

  // ── Hero video ───────────────────────────────────────────────────────────
  // Decorative loop. With reduced motion it stays paused on its first frame.
  function initVideo() {
    const video = document.getElementById('lp-hero-video');
    if (!video) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      if (reduce.matches) video.pause();
      else video.play().catch(() => {});
    };
    reduce.addEventListener('change', sync);
    sync();
  }

  // ── Navbar border once the page scrolls ──────────────────────────────────
  function initNav() {
    const nav = document.getElementById('lp-nav');
    if (!nav) return;
    const update = () => nav.classList.toggle('scrolled', window.scrollY > 8);
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  // ── Mobile menu ──────────────────────────────────────────────────────────
  function initMenu() {
    const btn = document.getElementById('lp-menu-btn');
    const menu = document.getElementById('lp-menu');
    if (!btn || !menu) return;
    const set = open => {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    btn.addEventListener('click', () => set(menu.hidden));
    menu.addEventListener('click', e => { if (e.target.closest('a')) set(false); });
  }

  // ── Reveal on scroll ─────────────────────────────────────────────────────
  function initReveal() {
    const targets = document.querySelectorAll('.lp-animate');
    if (!('IntersectionObserver' in window)) {
      targets.forEach(t => t.classList.add('lp-visible'));
      return;
    }
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add('lp-visible'); io.unobserve(e.target); }
      }
    }, { rootMargin: '0px 0px -8% 0px' });
    targets.forEach(t => io.observe(t));
  }

  // ── Tabs (ARIA tablist: click, arrows, Home and End) ─────────────────────
  function initTabs() {
    const list = document.querySelector('.lp-tablist');
    if (!list) return;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = tab => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      }
    };
    list.addEventListener('click', e => {
      const tab = e.target.closest('[role="tab"]');
      if (tab) select(tab);
    });
    list.addEventListener('keydown', e => {
      const i = tabs.indexOf(document.activeElement);
      if (i === -1) return;
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const tab = tabs[(next + tabs.length) % tabs.length];
      tab.focus();
      select(tab);
    });
  }

  // ── Decorative dot maps ──────────────────────────────────────────────────
  // A fixed pattern in the map's colors (blue you lead, gray even, red rival
  // leads). It is an illustration and carries no data. Each dot blends its
  // pole with the even gray in CSS (color-mix), so a theme switch recolors it.
  function initDots() {
    document.querySelectorAll('.lp-dots').forEach(el => {
      const n = Number(getComputedStyle(el).getPropertyValue('--n')) || 12;
      const rows = el.classList.contains('lp-dots-sm') ? 2 : 6;
      for (let i = 0; i < n * rows; i += 1) {
        const x = i % n, y = Math.floor(i / n);
        const t = Math.max(-1, Math.min(1, Math.sin(x * 0.9 + y * 0.55) * 0.6 + Math.cos(x * 0.35 - y * 0.8) * 0.5));
        const d = document.createElement('span');
        d.className = t >= 0 ? 'pr' : 'po';
        d.style.setProperty('--a', Math.round(Math.abs(t) * 100) + '%');
        d.style.transform = 'scale(' + (0.55 + ((Math.sin(i * 1.7) + 1) / 2) * 0.45).toFixed(2) + ')';
        el.appendChild(d);
      }
    });
  }

  // ── One-click live demo ──────────────────────────────────────────────────
  // The buttons stay hidden unless the server has a demo account. A click
  // signs the visitor into it (POST /api/auth/demo) and opens the app.
  async function initDemo() {
    const buttons = [...document.querySelectorAll('[data-demo]')];
    if (!buttons.length) return;
    try {
      const res = await fetch('/api/auth/config', { credentials: 'same-origin' });
      const cfg = await res.json();
      if (!cfg.demo) return;
    } catch (_) {
      return;
    }
    for (const btn of buttons) {
      btn.hidden = false;
      btn.addEventListener('click', async () => {
        const error = btn.closest('section').querySelector('[data-demo-error]');
        if (error) error.hidden = true;
        buttons.forEach(b => { b.disabled = true; });
        const label = btn.textContent;
        btn.textContent = 'Opening the demo...';
        try {
          const res = await fetch('/api/auth/demo', { method: 'POST', credentials: 'same-origin' });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.redirect) { window.location.href = data.redirect; return; }
          throw new Error(data.error || 'The live demo is not available right now.');
        } catch (err) {
          if (error) { error.textContent = err.message; error.hidden = false; }
          buttons.forEach(b => { b.disabled = false; });
          btn.textContent = label;
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initVideo();
    initNav();
    initMenu();
    initReveal();
    initTabs();
    initDots();
    initDemo();
  });
})();
