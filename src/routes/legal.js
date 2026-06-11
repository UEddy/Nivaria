// ── Legal pages (Phase 11C) ──────────────────────────────────────────────────
// Public, no-auth routes that render the Termly/generated legal documents inside
// a Nivaria-branded shell. The source HTML lives in docs/legal/*.html; each file
// marks the body to embed with an <article class="legal-document"> region between
// EMBEDDABLE REGION START/END comments. We extract that region verbatim (never
// modify the legal text) and wrap it in the app's design tokens + a shared footer.

const fs   = require('fs');
const path = require('path');
const { stripDashes } = require('../lib/sanitizeText');

const LEGAL_DIR = path.join(__dirname, '../../docs/legal');

// Each entry: route path → { file, title }. Title is the browser tab + page H-less
// header; the document supplies its own <h1> inside the article.
const DOCS = {
  privacy: { file: 'privacy-policy.html',   title: 'Privacy Policy'    },
  terms:   { file: 'terms-of-service.html', title: 'Terms of Service'  },
  cookies: { file: 'cookie-policy.html',    title: 'Cookie Policy'     },
};

// Pull the <article class="legal-document">…</article> region out of a source
// file. Falls back to the whole <body> if the marker isn't present, so a future
// doc without the comment markers still renders rather than 404-ing.
function extractArticle(html) {
  const articleMatch = html.match(/<article\b[^>]*class=["'][^"']*legal-document[^"']*["'][^>]*>[\s\S]*?<\/article>/i);
  if (articleMatch) return articleMatch[0];
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

// Read + cache the extracted articles once at startup. Legal docs change rarely
// (a redeploy is fine), so there's no reason to hit the disk per request.
const cache = {};
for (const [key, { file }] of Object.entries(DOCS)) {
  try {
    const raw = fs.readFileSync(path.join(LEGAL_DIR, file), 'utf8');
    // Enforce the no-dash convention (CLAUDE.md) on the rendered legal copy.
    // The source docs are third-party generated boilerplate we extract verbatim;
    // stripDashes converts any em/en dashes in the prose to commas at render
    // time, so users never see them and future doc updates stay compliant too.
    cache[key] = stripDashes(extractArticle(raw));
  } catch (err) {
    console.warn(`⚠️  legal: could not load ${file} — /${key} will 404 (${err.message})`);
    cache[key] = null;
  }
}

// ── Shared footer (used by the legal layout below; mirrored in the SPA + auth +
// landing footers so users see the same links everywhere) ─────────────────────
const FOOTER_LINKS = [
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms',   label: 'Terms of Service' },
  { href: '/cookies', label: 'Cookie Policy' },
  { href: 'mailto:support@nivaria.app', label: 'support@nivaria.app' },
];

function footerHtml() {
  const links = FOOTER_LINKS
    .map(l => `<a href="${l.href}">${l.label}</a>`)
    .join('');
  return `
  <footer class="legal-footer" role="contentinfo">
    <div class="legal-footer-inner">
      <span class="legal-footer-copy">&copy; 2026 Nivaria</span>
      <nav class="legal-footer-links" aria-label="Legal navigation">${links}</nav>
    </div>
  </footer>`;
}

// Full branded HTML document for a legal page.
function renderPage(title, articleHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nivaria: ${title}</title>
  <meta name="robots" content="all">
  <!-- Anti-flash: honor the saved theme before any paint (same 'cs-theme' key
       the dashboard + auth pages use, so the preference carries across). -->
  <script>
  (function () {
    var v = localStorage.getItem('cs-theme') || 'system';
    var r = v === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : v;
    document.documentElement.setAttribute('data-theme', r);
  })();
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔍</text></svg>">
  <style>
    :root {
      --lg-bg:      #000000;
      --lg-bg-2:    #0A0A0A;
      --lg-border:  rgba(255,255,255,0.08);
      --lg-txt:     #E8ECF4;
      --lg-txt-2:   #94A3B8;
      --lg-txt-3:   #64748B;
      --lg-accent:  #818CF8;
      --lg-nav-h:   64px;
      color-scheme: dark;
    }
    [data-theme="light"] {
      --lg-bg:      #FFFFFF;
      --lg-bg-2:    #F4F4F8;
      --lg-border:  rgba(0,0,0,0.10);
      --lg-txt:     #0C0C14;
      --lg-txt-2:   #475569;
      --lg-txt-3:   #64748B;
      --lg-accent:  #4F46E5;
      color-scheme: light;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--lg-bg);
      color: var(--lg-txt);
      -webkit-font-smoothing: antialiased;
      display: flex; flex-direction: column; min-height: 100vh;
      line-height: 1.6;
    }

    /* ── Header ─────────────────────────────────────────────── */
    .legal-nav {
      height: var(--lg-nav-h);
      border-bottom: 1px solid var(--lg-border);
      display: flex; align-items: center;
      position: sticky; top: 0; z-index: 10;
      background: color-mix(in srgb, var(--lg-bg) 88%, transparent);
      backdrop-filter: blur(12px);
    }
    .legal-nav-inner {
      width: 100%; max-width: 1080px; margin: 0 auto;
      padding: 0 24px;
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
    }
    .legal-logo {
      display: flex; align-items: center; gap: 10px;
      text-decoration: none; color: var(--lg-txt);
    }
    .legal-logo-icon {
      width: 32px; height: 32px; border-radius: 9px;
      background: var(--lg-accent);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .legal-logo-name { font-size: 16px; font-weight: 700; letter-spacing: -0.3px; }
    .legal-nav-back {
      font-size: 13.5px; font-weight: 600;
      color: var(--lg-txt-2); text-decoration: none;
      transition: color 0.15s ease;
    }
    .legal-nav-back:hover { color: var(--lg-accent); }

    /* ── Document container ─────────────────────────────────── */
    .legal-main { flex: 1; padding: 48px 24px 72px; }
    .legal-document {
      max-width: 760px; margin: 0 auto;
      line-height: 1.65; color: var(--lg-txt-2);
      font-size: 15px;
    }
    .legal-document h1 {
      font-size: 1.85rem; line-height: 1.2;
      color: var(--lg-txt); letter-spacing: -0.6px;
      margin: 0 0 0.5rem;
    }
    .legal-document h2 {
      font-size: 1.3rem; color: var(--lg-txt);
      letter-spacing: -0.3px;
      margin: 2.4rem 0 0.6rem;
      padding-top: 0.4rem;
    }
    .legal-document h3 {
      font-size: 1.05rem; color: var(--lg-txt);
      margin: 1.5rem 0 0.4rem;
    }
    .legal-document p, .legal-document li { margin: 0.55rem 0; }
    .legal-document strong { color: var(--lg-txt); font-weight: 600; }
    .legal-document ul, .legal-document ol { padding-left: 1.5rem; margin: 0.5rem 0; }
    .legal-document a {
      color: var(--lg-accent); text-decoration: underline;
      text-underline-offset: 2px; word-break: break-word;
    }
    .legal-document a:hover { text-decoration: none; }
    .legal-document table {
      border-collapse: collapse; width: 100%; margin: 1.25rem 0;
      font-size: 0.92em;
    }
    .legal-document th, .legal-document td {
      border: 1px solid var(--lg-border);
      padding: 0.55rem 0.7rem; text-align: left; vertical-align: top;
    }
    .legal-document thead th { font-weight: 600; color: var(--lg-txt); }
    .legal-document hr { border: none; border-top: 1px solid var(--lg-border); margin: 2rem 0; }

    /* ── Footer ─────────────────────────────────────────────── */
    .legal-footer {
      border-top: 1px solid var(--lg-border);
      padding: 28px 24px;
    }
    .legal-footer-inner {
      max-width: 1080px; margin: 0 auto;
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; flex-wrap: wrap;
    }
    .legal-footer-copy { font-size: 0.8125rem; color: var(--lg-txt-3); }
    .legal-footer-links { display: flex; gap: 22px; flex-wrap: wrap; }
    .legal-footer-links a {
      font-size: 0.8125rem; color: var(--lg-txt-2);
      text-decoration: none; transition: color 0.15s ease;
    }
    .legal-footer-links a:hover { color: var(--lg-accent); }

    @media (max-width: 600px) {
      .legal-main { padding: 32px 20px 56px; }
      .legal-document h1 { font-size: 1.55rem; }
      .legal-footer-inner { flex-direction: column; align-items: flex-start; gap: 14px; }
      .legal-footer-links { flex-direction: column; gap: 10px; }
    }
  </style>
</head>
<body>
  <nav class="legal-nav">
    <div class="legal-nav-inner">
      <a href="/" class="legal-logo" aria-label="Nivaria home">
        <span class="legal-logo-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
        </span>
        <span class="legal-logo-name">Nivaria</span>
      </a>
      <a href="/app" class="legal-nav-back">Back to app &rarr;</a>
    </div>
  </nav>

  <main class="legal-main">
    ${articleHtml}
  </main>

  ${footerHtml()}
</body>
</html>`;
}

// ── Route registration ────────────────────────────────────────────────────────
// Mounted directly on the app (not as a sub-router) so the paths stay /privacy,
// /terms, /cookies. Public — registered before the SPA catch-all in server.js.
function registerLegalRoutes(app) {
  for (const [key, { title }] of Object.entries(DOCS)) {
    app.get('/' + key, (_req, res) => {
      const article = cache[key];
      if (!article) return res.status(404).send('Document not available.');
      res.type('html').send(renderPage(title, article));
    });
  }
}

module.exports = { registerLegalRoutes };
