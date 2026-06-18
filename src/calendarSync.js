// Phase 7 — calendar sync service.
//
// Runs on a 15-minute cron + on-demand from the OAuth callback. For each
// active calendar_connection: refresh the token if it's near expiry, fetch
// upcoming events (next 72h), run the title/domain matcher against tracked
// competitors, upsert tracked_meetings rows.
//
// Tenant safety: every DB query is scoped by user_id. The matcher only
// reads competitors that belong to the connection's owner.
//
// Sanitization: event titles + attendee names/emails are length-capped and
// stripped of control chars before storage. Attendee emails are MASKED in
// logs ("e***@acme.com") — never logged in full.

const { getDb } = require('./db');
const { encrypt, decrypt } = require('./calendarTokens');
const { providerFor } = require('./calendarOAuth');

const MAX_TITLE_CHARS    = 300;
const MAX_ATTENDEES      = 50;
const MAX_ATTENDEE_FIELD = 200;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh if expiring within 5 min

// ── Sanitization ────────────────────────────────────────────────────────────

function stripControlChars(s) {
  // Strip C0 controls (U+0000–U+001F) and DEL (U+007F); leave Unicode alone.
  return String(s || '').replace(/[\x00-\x1F\x7F]/g, ' ');
}

function sanitizeTitle(raw) {
  return stripControlChars(raw).trim().slice(0, MAX_TITLE_CHARS);
}

function sanitizeAttendee(a) {
  if (!a || !a.email) return null;
  // For the email we drop control/whitespace entirely (replacing with spaces
  // would corrupt the addr-spec). Then validate — malformed emails can't
  // match any competitor.domain so dropping them is the safe default.
  const email = String(a.email).replace(/[\x00-\x1F\x7F\s]/g, '').toLowerCase().slice(0, MAX_ATTENDEE_FIELD);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const domain = email.split('@')[1] || '';
  return {
    email,
    name:   stripControlChars(a.name || '').trim().slice(0, MAX_ATTENDEE_FIELD) || null,
    domain: domain.replace(/^www\./, ''),
  };
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return '<no-email>';
  const [local, host] = email.split('@');
  if (!local || !host) return '<malformed>';
  return `${local[0]}***@${host}`;
}

// ── Token handling ──────────────────────────────────────────────────────────

async function ensureFreshAccessToken(connection) {
  const expiresAt = connection.expires_at ? new Date(connection.expires_at).getTime() : null;
  const needsRefresh = !expiresAt || (expiresAt - Date.now()) < TOKEN_REFRESH_SKEW_MS;
  if (!needsRefresh) return decrypt(connection.access_token_enc);

  if (!connection.refresh_token_enc) {
    throw new Error('Token expired and no refresh token stored. User must re-connect.');
  }
  const provider = providerFor(connection.provider);
  const refresh  = decrypt(connection.refresh_token_enc);
  const fresh    = await provider.refreshAccessToken(refresh);
  if (!fresh.access) throw new Error('Token refresh returned no access token');

  const db = getDb();
  db.prepare(`
    UPDATE calendar_connections
    SET access_token_enc = ?, expires_at = ?, status = 'active', last_sync_error = NULL
    WHERE id = ?
  `).run(encrypt(fresh.access), fresh.expiresAt, connection.id);

  console.log(`[calendar] 🔁 Token refreshed for connection ${connection.id} (${connection.provider})`);
  return fresh.access;
}

// ── Matching ────────────────────────────────────────────────────────────────

// Title match: case-insensitive substring of any competitor name as a
// whole-word boundary so "Acme Co" matches but "academy" doesn't match "acme".
// Domain match: any attendee whose email's domain equals competitor.domain.
// Returns { competitorId, reason } or null. Title wins over domain.
function matchEvent(competitors, event) {
  const title = (event.title || '').toLowerCase();
  for (const c of competitors) {
    if (!c.name) continue;
    const needle = c.name.toLowerCase().trim();
    if (!needle) continue;
    // Word-boundary check to avoid spurious substring matches.
    const re = new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i');
    if (re.test(title)) return { competitorId: c.id, reason: 'title' };
  }

  const eventDomains = new Set(
    (event.attendees || []).map(a => a.domain).filter(Boolean)
  );
  for (const c of competitors) {
    if (c.domain && eventDomains.has(c.domain)) {
      return { competitorId: c.id, reason: 'domain' };
    }
  }
  return null;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Sync orchestration ──────────────────────────────────────────────────────

// Syncs one connection. Returns a small summary object suitable for the
// sync-now route and for the cron log line.
async function syncOneConnection({ userId, provider = 'google', connectionId } = {}) {
  const db = getDb();
  const conn = connectionId
    ? db.prepare("SELECT * FROM calendar_connections WHERE id = ?").get(connectionId)
    : db.prepare("SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ?").get(userId, provider);

  if (!conn) throw new Error('No calendar connection for this user/provider');
  if (conn.status !== 'active') throw new Error(`Connection status is ${conn.status}. Re-authenticate first.`);

  const t0 = Date.now();
  let accessToken;
  try {
    accessToken = await ensureFreshAccessToken(conn);
  } catch (refreshErr) {
    db.prepare(
      "UPDATE calendar_connections SET status = 'expired', last_sync_error = ? WHERE id = ?"
    ).run(refreshErr.message.slice(0, 500), conn.id);
    console.error(`[calendar] ⚠️  Refresh failed for connection ${conn.id}: ${refreshErr.message}`);
    // Best-effort re-auth nudge — never block the cron if email fails.
    try {
      await sendReauthEmail(conn.user_id, conn.provider, conn.account_email);
    } catch (mailErr) {
      console.warn(`[calendar] re-auth email failed: ${mailErr.message}`);
    }
    throw refreshErr;
  }

  const competitors = db.prepare(
    'SELECT id, name, domain FROM competitors WHERE user_id = ? AND active = 1'
  ).all(conn.user_id);

  const providerImpl = providerFor(conn.provider);
  const events = await providerImpl.listUpcomingEvents(accessToken, { hoursAhead: 72 });

  let matchedCount = 0;
  let upsertedCount = 0;

  for (const ev of events) {
    const title     = sanitizeTitle(ev.title);
    const attendees = (ev.attendees || []).map(sanitizeAttendee).filter(Boolean).slice(0, MAX_ATTENDEES);
    const cleaned   = { ...ev, title, attendees };
    const match     = matchEvent(competitors, cleaned);

    // Preserve a prior MANUAL tag — the user's choice trumps auto-matching.
    const existing = db.prepare(
      'SELECT id, matched_competitor_id, match_reason, briefing_status FROM tracked_meetings WHERE user_id = ? AND provider = ? AND external_event_id = ?'
    ).get(conn.user_id, conn.provider, ev.id);

    let matched_competitor_id, match_reason;
    if (existing && existing.match_reason === 'manual') {
      matched_competitor_id = existing.matched_competitor_id;
      match_reason          = 'manual';
    } else if (match) {
      matched_competitor_id = match.competitorId;
      match_reason          = match.reason;
    } else {
      matched_competitor_id = null;
      match_reason          = 'none';
    }
    if (matched_competitor_id) matchedCount++;

    // Reset briefing_status to 'pending' when match changes; preserve 'sent'
    // when nothing relevant changed so we never double-send.
    let briefing_status = existing?.briefing_status || 'pending';
    if (existing) {
      const changed =
        existing.matched_competitor_id !== matched_competitor_id ||
        existing.match_reason !== match_reason;
      if (changed) briefing_status = 'pending';
    }

    db.prepare(`
      INSERT INTO tracked_meetings
        (user_id, connection_id, provider, external_event_id, title, start_time, end_time,
         attendees, matched_competitor_id, match_reason, briefing_status, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, provider, external_event_id) DO UPDATE SET
        title                 = excluded.title,
        start_time            = excluded.start_time,
        end_time              = excluded.end_time,
        attendees             = excluded.attendees,
        matched_competitor_id = excluded.matched_competitor_id,
        match_reason          = excluded.match_reason,
        briefing_status       = excluded.briefing_status,
        last_synced_at        = CURRENT_TIMESTAMP
    `).run(
      conn.user_id, conn.id, conn.provider, ev.id, title, cleaned.start, cleaned.end,
      JSON.stringify(attendees), matched_competitor_id, match_reason, briefing_status,
    );
    upsertedCount++;
  }

  db.prepare("UPDATE calendar_connections SET last_synced_at = CURRENT_TIMESTAMP, last_sync_error = NULL WHERE id = ?").run(conn.id);

  const summary = {
    connection_id: conn.id,
    user_id: conn.user_id,
    provider: conn.provider,
    events_fetched: events.length,
    upserted: upsertedCount,
    matched: matchedCount,
    duration_ms: Date.now() - t0,
  };
  console.log(`[calendar] ✅ sync conn=${conn.id} provider=${conn.provider} events=${summary.events_fetched} matched=${summary.matched} duration=${summary.duration_ms}ms`);
  // Mask any attendee details from the log — only counts.
  return summary;
}

async function runScheduledSync() {
  const db = getDb();
  const conns = db.prepare(
    "SELECT id FROM calendar_connections WHERE status = 'active'"
  ).all();
  if (conns.length === 0) return;

  console.log(`[calendar] ⏰ Scheduled sync: ${conns.length} connection(s)...`);
  for (const { id } of conns) {
    try { await syncOneConnection({ connectionId: id }); }
    catch (e) { console.error(`[calendar] sync failed for ${id}: ${e.message}`); }
  }
}

// Best-effort email nudge when refresh fails. Uses Resend if RESEND_API_KEY
// is set; otherwise logs and returns.
async function sendReauthEmail(userId, provider, accountEmail) {
  const db   = getDb();
  const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
  if (!user?.email) return;
  if (!process.env.RESEND_API_KEY) {
    console.log(`[calendar] (dev) re-auth needed for user ${userId} (${provider})`);
    return;
  }
  const axios = require('axios');
  const { buildCalendarReauthHtml } = require('./email');
  const FROM = process.env.RESEND_FROM || 'Nivaria <onboarding@resend.dev>';
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  await axios.post(
    'https://api.resend.com/emails',
    {
      from: FROM,
      to: [user.email],
      subject: 'Nivaria: re-connect your calendar',
      html: buildCalendarReauthHtml({ name: user.name, provider, accountEmail, appUrl }),
    },
    { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 }
  );
}

module.exports = {
  syncOneConnection,
  runScheduledSync,
  matchEvent,           // exported for tests
  sanitizeTitle,
  sanitizeAttendee,
  maskEmail,
};
