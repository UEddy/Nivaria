/* Landing page — scroll effects, theme toggle, animations */

(function () {
  const THEME_KEY = 'lp-theme';

  // ── Theme ──────────────────────────────────────────────────
  function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(val) {
    const resolved = val === 'system' ? getSystemTheme() : val;
    document.documentElement.setAttribute('data-lp-theme', resolved);
    localStorage.setItem(THEME_KEY, val);
    updateThemeIcon(resolved);
  }

  function updateThemeIcon(resolved) {
    const btn = document.getElementById('lp-theme-btn');
    if (!btn) return;
    btn.innerHTML = resolved === 'light'
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'system';
    applyTheme(saved);

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme('system');
    });

    const btn = document.getElementById('lp-theme-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        const current = localStorage.getItem(THEME_KEY) || 'system';
        const resolved = current === 'system' ? getSystemTheme() : current;
        applyTheme(resolved === 'light' ? 'dark' : 'light');
      });
    }
  }

  // ── Navbar scroll ──────────────────────────────────────────
  function initNavScroll() {
    const nav = document.getElementById('lp-nav');
    if (!nav) return;
    let ticking = false;
    function update() {
      nav.classList.toggle('scrolled', window.scrollY > 20);
      ticking = false;
    }
    window.addEventListener('scroll', () => {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  }

  // ── Scroll animations ─────────────────────────────────────
  function initScrollAnimations() {
    const targets = document.querySelectorAll('.lp-animate');
    if (!targets.length) return;

    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('lp-visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });

    targets.forEach(t => io.observe(t));
  }

  // ── Mobile menu ────────────────────────────────────────────
  function initMobileMenu() {
    const btn = document.getElementById('lp-mobile-menu-btn');
    const menu = document.getElementById('lp-mobile-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', () => {
      const open = menu.style.display === 'flex';
      menu.style.display = open ? 'none' : 'flex';
    });
  }

  // ── Hero video fallback ────────────────────────────────────
  // Also honours prefers-reduced-motion: the loop is indefinite background
  // motion, so for those visitors we hold it on the first frame rather than
  // playing it. The overlay gradient still reads the same either way.
  function initVideo() {
    const video = document.getElementById('lp-hero-video');
    if (!video) return;
    video.addEventListener('error', () => {
      video.style.display = 'none';
    });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      video.removeAttribute('autoplay');
      video.autoplay = false;
      video.pause();
    }
  }

  // ── Demo video (lazy Vimeo embed) ──────────────────────────
  // Nothing is requested from Vimeo until the visitor clicks the facade, so the
  // initial page render is never blocked by the player. On click we build the
  // iframe with a clean parameter set (no title/byline/portrait) and autoplay it,
  // which is allowed because the click is a user gesture.
  function initDemoVideo() {
    const btn = document.getElementById('lp-demo-play');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-vimeo-id');
      if (!id) return;
      const iframe = document.createElement('iframe');
      // Official Vimeo embed params (badge/autopause/player_id/app_id) plus a clean
      // chrome set (no title/byline/portrait) and autoplay, allowed under the click.
      iframe.src = 'https://player.vimeo.com/video/' + encodeURIComponent(id) +
        '?badge=0&autopause=0&player_id=0&app_id=58479' +
        '&autoplay=1&title=0&byline=0&portrait=0&dnt=1';
      iframe.title = 'Nivaria product demo';
      iframe.loading = 'lazy';
      iframe.allow = 'autoplay; fullscreen; picture-in-picture';
      iframe.setAttribute('allowfullscreen', '');
      const frame = btn.closest('.lp-video-frame');
      if (!frame) return;
      frame.replaceChildren(iframe);
    }, { once: true });
  }

  // ── Init ──────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initNavScroll();
    initScrollAnimations();
    initMobileMenu();
    initVideo();
    initDemoVideo();
  });
})();
