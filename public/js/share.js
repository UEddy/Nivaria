// The public page behind a shared Taste Gap link (/share/<token>): read-only,
// no login. It loads the brief from /api/share/<token> and draws it with the
// app's own Taste Gap renderer (taste.js, Taste.renderShared), so the brief,
// map and chart look exactly as they do in the app.
//
// taste.js reads a few helpers the app shell (app.js) normally defines. The
// app shell itself is not loaded here (it would ask for a login), so these
// are the same helpers, kept small.

function el(id) { return document.getElementById(id); }

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// SQLite timestamps are UTC with no zone marker.
function parseDbDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  return new Date(s);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return parseDbDate(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toast() {}

document.addEventListener('DOMContentLoaded', async () => {
  const root = el('page-root');
  const token = location.pathname.split('/').filter(Boolean)[1] || '';
  try {
    const res = await fetch('/api/share/' + encodeURIComponent(token), { headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (!res.ok) throw new Error('gone');
    const { run } = await res.json();
    window.Taste.renderShared(run, root);
  } catch (_) {
    root.innerHTML = `
      <div class="empty-state share-gone">
        <div class="empty-title">This brief is no longer available</div>
        <div class="empty-desc">The link was turned off by the person who shared it, or it was never valid. Nivaria shows a consumer brand where a rival's audience is that its own is not, using Qloo taste data.</div>
        <a class="btn btn-primary" href="/register">Get started</a>
      </div>`;
  }
});
