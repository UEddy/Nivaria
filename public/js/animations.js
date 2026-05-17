// ── Prefers-reduced-motion gate ────────────────────────────────────────────────
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Constellation / Particle System ───────────────────────────────────────────
class ConstellationSystem {
  constructor() {
    this.canvas = document.getElementById('particle-canvas');
    if (!this.canvas || reducedMotion) return;
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.N = 60;
    this.maxDist = 145;
    this.maxDist2 = this.maxDist * this.maxDist;
    this.running = false;

    this.resize();
    window.addEventListener('resize', () => this.resize(), { passive: true });
    this.seed();
    this.start();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width  = window.innerWidth  * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width  = window.innerWidth  + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.ctx.scale(dpr, dpr);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
  }

  seed() {
    this.particles = [];
    for (let i = 0; i < this.N; i++) {
      this.particles.push({
        x:  Math.random() * this.W,
        y:  Math.random() * this.H,
        vx: (Math.random() - 0.5) * 0.26,
        vy: (Math.random() - 0.5) * 0.26,
        r:  Math.random() * 1.0 + 0.4,
      });
    }
  }

  rgb() {
    return document.documentElement.getAttribute('data-theme') === 'light'
      ? '79,70,229' : '99,102,241';
  }

  tick() {
    if (!this.running) return;
    const { ctx, particles: ps, W, H, maxDist, maxDist2 } = this;
    const rgb = this.rgb();

    ctx.clearRect(0, 0, W, H);

    // Move
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < -12) p.x = W + 12;
      else if (p.x > W + 12) p.x = -12;
      if (p.y < -12) p.y = H + 12;
      else if (p.y > H + 12) p.y = -12;
    }

    // Connections (O(n²) but N=60 is fine)
    ctx.lineWidth = 0.55;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const dx = ps[i].x - ps[j].x;
        const dy = ps[i].y - ps[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < maxDist2) {
          const alpha = (1 - Math.sqrt(d2) / maxDist) * 0.085;
          ctx.strokeStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(ps[i].x, ps[i].y);
          ctx.lineTo(ps[j].x, ps[j].y);
          ctx.stroke();
        }
      }
      // Dot
      ctx.beginPath();
      ctx.arc(ps[i].x, ps[i].y, ps[i].r, 0, 6.2832);
      ctx.fillStyle = `rgba(${rgb},0.14)`;
      ctx.fill();
    }

    requestAnimationFrame(() => this.tick());
  }

  start() {
    this.running = true;
    requestAnimationFrame(() => this.tick());
  }
}

// ── Live Clock ─────────────────────────────────────────────────────────────────
class LiveClock {
  constructor() {
    this.el = document.getElementById('live-clock');
    if (!this.el) return;
    this.update();
    setInterval(() => this.update(), 1000);
  }

  update() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    this.el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}

// ── Stagger Animate In ─────────────────────────────────────────────────────────
// Call after inserting items into the DOM.
window.staggerIn = function staggerIn(selector, baseMs = 30, stepMs = 65) {
  if (reducedMotion) return;
  requestAnimationFrame(() => {
    const items = [...document.querySelectorAll(selector)];
    items.forEach((el, i) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(13px)';
      el.style.transition = 'none';
      setTimeout(() => {
        el.style.transition = 'opacity 0.32s ease, transform 0.32s cubic-bezier(.16,1,.3,1)';
        el.style.opacity = '1';
        el.style.transform = 'none';
        // clean up inline after animation finishes
        setTimeout(() => {
          el.style.transition = '';
          el.style.opacity    = '';
          el.style.transform  = '';
        }, 380);
      }, baseMs + i * stepMs);
    });
  });
};

// ── Page Transition ────────────────────────────────────────────────────────────
// Call right after setting innerHTML on the page root.
window.pageTransitionIn = function pageTransitionIn(el) {
  if (!el || reducedMotion) return;
  el.style.opacity = '0';
  el.style.transform = 'translateY(9px)';
  // double-rAF ensures style is applied before transition starts
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.transition = 'opacity 0.26s ease, transform 0.26s cubic-bezier(.16,1,.3,1)';
    el.style.opacity = '1';
    el.style.transform = 'none';
    setTimeout(() => {
      el.style.transition = '';
      el.style.opacity    = '';
      el.style.transform  = '';
    }, 360);
  }));
};

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  new ConstellationSystem();
  new LiveClock();
});
