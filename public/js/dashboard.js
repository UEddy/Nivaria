const Dashboard = {
  async render() {
    try {
      const [stats, changesData, competitors] = await Promise.all([
        API.getStats(),
        API.getChanges({ limit: 6 }),
        API.getCompetitors(),
      ]);
      App.stats = stats;
      App.updateBadges();
      el('page-root').innerHTML = Dashboard.html(stats, changesData.changes, competitors);
      Dashboard.animateStats(stats);
      window.staggerIn?.('.feed-item', 80, 70);
      window.staggerIn?.('.competitor-mini', 120, 55);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <div class="empty-title">Could not load dashboard</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
    }
  },

  animateStats(stats) {
    const score = stats.total_competitors > 0
      ? Math.min(100, Math.round((stats.total_changes / Math.max(1, stats.total_competitors)) * 12 + stats.active_competitors * 8))
      : 0;

    const targets = {
      'stat-val-competitors': stats.total_competitors,
      'stat-val-changes': stats.changes_this_week,
      'stat-val-threats': stats.high_threats,
      'stat-val-score': score,
    };

    Object.entries(targets).forEach(([id, target]) => {
      const node = document.getElementById(id);
      if (node) animateCounter(node, target, 900);
    });
  },

  html(stats, changes, competitors) {
    const score = stats.total_competitors > 0
      ? Math.min(100, Math.round((stats.total_changes / Math.max(1, stats.total_competitors)) * 12 + stats.active_competitors * 8))
      : 0;

    const slotMax = App.user?.tier === 'free' ? 1 : App.user?.tier === 'team' ? null : 10;
    const slotPct = slotMax ? Math.min(100, (stats.total_competitors / slotMax) * 100) : 20;
    const slotWarn = slotMax && stats.total_competitors / slotMax > 0.8;

    return `
      <!-- Hero Stats -->
      <div class="hero-stats">
        <div class="hero-stat stat-indigo">
          <div class="hero-stat-label">Competitors Tracked</div>
          <div class="hero-stat-value" id="stat-val-competitors">0</div>
          <div class="hero-stat-sub">${stats.active_competitors} active right now</div>
        </div>
        <div class="hero-stat stat-cyan">
          <div class="hero-stat-label">Changes This Week</div>
          <div class="hero-stat-value" id="stat-val-changes">0</div>
          <div class="hero-stat-sub">${stats.total_changes} total detected</div>
        </div>
        <div class="hero-stat stat-red">
          <div class="hero-stat-label">High Threat Alerts</div>
          <div class="hero-stat-value" id="stat-val-threats">0</div>
          <div class="hero-stat-sub">${stats.medium_threats} medium priority</div>
        </div>
        <div class="hero-stat stat-green">
          <div class="hero-stat-label">Intelligence Score</div>
          <div class="hero-stat-value" id="stat-val-score">0</div>
          <div class="hero-stat-sub">out of 100 possible</div>
        </div>
      </div>

      ${stats.high_threats > 0 ? `
        <div class="alert-banner">
          <div class="alert-banner-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div>
            <div class="alert-banner-title">${stats.high_threats} high-threat change${stats.high_threats > 1 ? 's' : ''} require attention</div>
            <div class="alert-banner-sub">Review the latest changes and prepare your sales team response</div>
          </div>
          <a href="#/history?threat=high" class="btn btn-danger btn-sm" style="margin-left:auto;flex-shrink:0">Review Now</a>
        </div>
      ` : ''}

      <!-- Radar / Monitoring Status -->
      <div class="radar-widget">
        <div class="radar-visual">
          <div class="radar-ring"></div>
          <div class="radar-ring"></div>
          <div class="radar-ring"></div>
          <div class="radar-core"></div>
        </div>
        <div class="radar-body">
          <div class="radar-label">Intelligence Radar</div>
          <div class="radar-status">
            ${stats.active_competitors > 0
              ? `Actively monitoring ${stats.active_competitors} competitor${stats.active_competitors !== 1 ? 's' : ''}`
              : 'No competitors being monitored'
            }
          </div>
          <div class="radar-meta">
            ${stats.total_changes} change${stats.total_changes !== 1 ? 's' : ''} detected all-time
            · ${stats.changes_this_week} this week
          </div>
        </div>
        <div class="radar-next">09:00 daily</div>
      </div>

      <!-- Main grid -->
      <div class="dashboard-grid">

        <!-- Recent Changes -->
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Recent Changes</div>
              <div class="card-sub">Latest competitor intelligence</div>
            </div>
            <a href="#/history" class="btn btn-ghost btn-sm">View all →</a>
          </div>
          ${changes.length === 0
            ? `<div class="empty-state" style="padding:40px 0">
                <div class="empty-icon">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                </div>
                <div class="empty-title">No changes detected yet</div>
                <div class="empty-desc">Add competitors and run your first check to see intelligence here.</div>
                <a href="#/competitors" class="btn btn-primary btn-sm">Add Competitor</a>
               </div>`
            : changes.map(c => `
                <div class="feed-item" onclick="navigate('/history/${c.id}')" style="cursor:pointer">
                  <div class="feed-pip ${c.threat_level || 'low'}"></div>
                  <div class="feed-body">
                    <div class="feed-headline">${esc(c.headline || 'Change detected')}</div>
                    <div class="feed-meta">
                      <span>${esc(c.competitor_name)}</span>
                      <span class="feed-dot-sep">·</span>
                      <span>${timeAgo(c.detected_at)}</span>
                      ${threatBadge(c.threat_level)}
                    </div>
                  </div>
                  <a class="feed-link" href="#/history/${c.id}" onclick="event.stopPropagation()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                  </a>
                </div>
              `).join('')
          }
        </div>

        <!-- Active Competitors -->
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Active Competitors</div>
              <div class="card-sub">${competitors.filter(c => c.active).length} being monitored</div>
            </div>
            <a href="#/competitors" class="btn btn-ghost btn-sm">Manage →</a>
          </div>
          ${competitors.length === 0
            ? `<div class="empty-state" style="padding:32px 0">
                <div class="empty-icon">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div class="empty-title">No competitors yet</div>
                <div class="empty-desc">Start monitoring your rivals.</div>
                <a href="#/competitors" class="btn btn-primary btn-sm">Add First</a>
               </div>`
            : competitors.slice(0, 8).map(c => `
                <div class="competitor-mini">
                  ${avatarHtml(c.name, 34)}
                  <div class="comp-mini-body">
                    <div class="comp-mini-name">${esc(c.name)}</div>
                    <div class="comp-mini-url">${esc(c.url.replace(/^https?:\/\//, '').substring(0, 40))}${c.url.length > 46 ? '…' : ''}</div>
                  </div>
                  <div class="comp-mini-right">
                    ${c.last_threat ? threatBadge(c.last_threat) : ''}
                    <span class="comp-mini-status ${c.active ? 'status-active' : 'status-paused'}">${c.active ? 'Active' : 'Paused'}</span>
                  </div>
                </div>
              `).join('')
          }
          ${competitors.length > 0 ? `
            <div class="usage-wrap">
              <div class="usage-label">
                <span>Competitor slots</span>
                <span>${stats.total_competitors} / ${App.user?.tier === 'free' ? '1' : App.user?.tier === 'team' ? '∞' : '10'}</span>
              </div>
              <div class="usage-bar">
                <div class="usage-fill ${slotWarn ? 'warn' : ''}" style="width:${slotPct}%"></div>
              </div>
            </div>
          ` : ''}
        </div>

      </div>
    `;
  },
};
