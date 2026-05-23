// Phase 7 — live end-to-end runner against real Google + real webhook.
//
// What it tests:
//   • Test 4  — recent-change briefing: seeds a fixture competitor with a
//     fresh high-threat change, inserts a tracked_meeting at +30 min, calls
//     dispatchOne, Haiku condenses talking points, payload POSTed to your
//     Discord webhook; verifies briefing_status='sent'
//   • Test 5  — empty-change variant: fixture competitor whose only change
//     is >14 days old (out of window); lighter "no recent material changes"
//     brief lands; verifies no Haiku call is made (cost-correct)
//   • Test 7a — token refresh happy path: forces expires_at into the past,
//     verifies refresh_token round-trip and new access_token rotation
//   • Test 7b — expired-status fallback: swaps in a bogus refresh_token,
//     verifies connection flips to status='expired'; then restores the real
//     token and re-verifies that refresh works again
//
// How to run:
//   1. Stop the dev server first  (sql.js holds the DB in memory; an
//      external write would be overwritten on the server's next saveDb)
//   2. node test-phase7-live.js
//   3. Start the server again
//
// Prerequisites:
//   • User eddyhamezz@gmail.com exists with tier='pro' or 'team'
//   • calendar_connections row for that user with valid refresh_token (i.e.
//     OAuth has been completed via the Settings UI at least once)
//   • settings.discord_webhook saved for that user
//   • settings.briefings_enabled=1
//   • ANTHROPIC_API_KEY in .env (Test 4 needs Haiku; Tests 5 and 7 do not)
//
// Fixtures: seeds two competitors prefixed "TEST-PHASE7-" — cleaned up
// idempotently on every run, so re-running is safe. After the final run
// drop them with a one-liner DELETE or via the cleanup helper.

require('dotenv').config();
process.env.OAUTH_DEBUG = process.env.OAUTH_DEBUG || '';

const { initDb, getDb } = require('./src/db');
const { dispatchOne, runScheduledDispatch } = require('./src/briefingDispatch');
const { syncOneConnection } = require('./src/calendarSync');
const { encrypt, decrypt } = require('./src/calendarTokens');

const USER_EMAIL = 'eddyhamezz@gmail.com';
const F_RECENT = 'TEST-PHASE7-Recent';
const F_QUIET  = 'TEST-PHASE7-Quiet';
let pass = 0, fail = 0;
function ok(label) { console.log(`  ✓ ${label}`); pass++; }
function bad(label, detail) { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }

(async () => {
  await initDb();
  const db = getDb();

  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(USER_EMAIL);
  if (!user) { console.error(`No user ${USER_EMAIL}`); process.exit(1); }
  const userId = user.id;

  // Pre-flight: confirm Discord webhook is saved + briefings enabled
  const settings = db.prepare("SELECT * FROM settings WHERE user_id = ?").get(userId);
  console.log(`\nPre-flight:`);
  console.log(`  user_id=${userId}`);
  console.log(`  briefings_enabled=${settings?.briefings_enabled}`);
  console.log(`  briefing_lead_minutes=${settings?.briefing_lead_minutes}`);
  console.log(`  discord_webhook=${settings?.discord_webhook ? '✓ set (length ' + settings.discord_webhook.length + ')' : '✗ MISSING'}`);
  console.log(`  slack_webhook=${settings?.slack_webhook ? '✓ set' : '(none)'}`);
  if (!settings?.discord_webhook) { console.error('Discord webhook missing — save it in Settings first.'); process.exit(1); }
  if (settings.briefings_enabled !== 1) { console.error('briefings_enabled is 0 — toggle it on in Settings.'); process.exit(1); }

  // ─── Clean previous test fixtures, idempotent ─────────────────────────────
  const old = db.prepare("SELECT id FROM competitors WHERE user_id = ? AND name LIKE 'TEST-PHASE7-%'").all(userId);
  for (const { id } of old) {
    db.prepare('DELETE FROM tracked_meetings WHERE matched_competitor_id = ?').run(id);
    db.prepare('DELETE FROM changes WHERE competitor_id = ?').run(id);
    db.prepare('DELETE FROM competitors WHERE id = ?').run(id);
  }
  console.log(`\nCleared ${old.length} prior TEST-PHASE7-* competitor(s).`);

  const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const futureIso = (mins) => new Date(Date.now() + mins * 60 * 1000).toISOString();
  const pastIso   = (days) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══ TEST 4: briefing dispatch w/ recent meaningful change ══');

  const recentCompId = db.prepare(`
    INSERT INTO competitors (user_id, name, url, description, domain, active)
    VALUES (?, ?, 'https://test-phase7-recent.example.com', 'Phase 7 Test 4 fixture', 'test-phase7-recent.example.com', 1)
  `).run(userId, F_RECENT).lastInsertRowid;

  const richAnalysis = {
    is_meaningful: true,
    changed_what: `${F_RECENT} restructured pricing from 2 tiers to 3 with annual-billing requirement.`,
    why_it_matters: 'Pricing restructure with seat minimums and annual billing — directly hits live mid-market deals already in negotiation.',
    threat_level: 'high',
    threat_reasoning: 'Repricing across tiers + new seat minimum + mandatory annual billing — all of these affect any active comparison conversation.',
    recommended_response: 'Brief sales on the new tiers immediately; lead with no-seat-minimum + monthly-billing flexibility as differentiators.',
    talking_points: [
      "TEST-PHASE7-Recent's entry tier is now 52% more expensive — we hold the line at the old price.",
      'They now require annual billing on mid+top tiers; we still offer monthly with no penalty.',
      'Their new "Enterprise" tier mandates a 50-seat minimum — most of our buyers are 20-100 seats.',
      'Implementation support is locked behind their top tier now; we include it on every plan.',
    ],
    headline: 'TEST-PHASE7-Recent overhauls pricing: 3 tiers, 52% base hike, mandatory annual',
    summary: 'Two tiers → three. Base price up 52%. Seat minimums introduced on Pro and Enterprise. Annual billing now mandatory above the entry tier.',
    key_changes: [
      { category: 'pricing', description: 'Base tier $5.25 → $8.00', impact: 'All entry-tier customers see a 52% increase' },
      { category: 'pricing', description: 'New 25 / 50 seat minimums', impact: 'SMB buyers locked out of upper tiers' },
    ],
    opportunity: 'Aggressive flexibility narrative — we keep monthly billing and no seat floor.',
    historical_context: '',
    pattern_tags: ['pricing_change', 'plan_restructure'],
  };

  const changeRowId = db.prepare(`
    INSERT INTO changes
      (competitor_id, diff_summary, analysis, threat_level, recommended_response,
       talking_points, headline, analysis_status, is_meaningful, detected_at)
    VALUES (?, '{}', ?, 'high', ?, ?, ?, 'ok', 1, ?)
  `).run(
    recentCompId,
    JSON.stringify(richAnalysis),
    richAnalysis.recommended_response,
    JSON.stringify(richAnalysis.talking_points),
    richAnalysis.headline,
    nowIso(),
  ).lastInsertRowid;
  ok(`fixture: competitor#${recentCompId} ${F_RECENT} + change#${changeRowId} (high threat)`);

  const meetingId4 = db.prepare(`
    INSERT INTO tracked_meetings
      (user_id, provider, external_event_id, title, start_time, end_time,
       attendees, matched_competitor_id, match_reason, briefing_status)
    VALUES (?, 'google', ?, ?, ?, ?, '[]', ?, 'title', 'pending')
  `).run(
    userId,
    'TEST-PHASE7-evt-recent-' + Date.now(),
    'TEST-PHASE7-Recent deal review — Q3 renewal',
    futureIso(30),
    futureIso(60),
    recentCompId,
  ).lastInsertRowid;
  ok(`fixture: tracked_meeting#${meetingId4} start_time=+30min, matched to ${F_RECENT}`);

  console.log('  → dispatching...');
  const meetingRow = db.prepare(`
    SELECT m.*, s.briefing_lead_minutes
    FROM tracked_meetings m LEFT JOIN settings s ON s.user_id = m.user_id
    WHERE m.id = ?
  `).get(meetingId4);
  const r4 = await dispatchOne(meetingRow);
  console.log(`  dispatch result: ${JSON.stringify(r4)}`);

  if (r4.status === 'sent' && r4.channels?.includes('discord')) ok('Discord briefing sent successfully');
  else bad('Discord briefing did NOT send', JSON.stringify(r4));

  const after4 = db.prepare("SELECT briefing_status, briefing_sent_at, briefing_error FROM tracked_meetings WHERE id = ?").get(meetingId4);
  if (after4.briefing_status === 'sent') ok(`DB briefing_status flipped to 'sent' (briefing_sent_at=${after4.briefing_sent_at})`);
  else bad(`DB briefing_status is ${after4.briefing_status}`, after4.briefing_error || '');
  if (r4.ai_usage) ok(`Haiku usage: in=${r4.ai_usage.input_tokens} out=${r4.ai_usage.output_tokens} ≈$${(r4.ai_cost_usd||0).toFixed(5)}`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══ TEST 5: empty-change briefing variant ══');

  const quietCompId = db.prepare(`
    INSERT INTO competitors (user_id, name, url, description, domain, active)
    VALUES (?, ?, 'https://test-phase7-quiet.example.com', 'Phase 7 Test 5 fixture', 'test-phase7-quiet.example.com', 1)
  `).run(userId, F_QUIET).lastInsertRowid;

  // Insert ONE change but from 30 days ago, so it's outside the 14-day window.
  db.prepare(`
    INSERT INTO changes
      (competitor_id, diff_summary, analysis, threat_level, headline, analysis_status, is_meaningful, detected_at)
    VALUES (?, '{}', '{}', 'low', 'TEST-PHASE7-Quiet old change (should be filtered out)', 'ok', 1, ?)
  `).run(quietCompId, pastIso(30));
  ok(`fixture: competitor#${quietCompId} ${F_QUIET} + stale change (30d old, outside 14d window)`);

  const meetingId5 = db.prepare(`
    INSERT INTO tracked_meetings
      (user_id, provider, external_event_id, title, start_time, end_time,
       attendees, matched_competitor_id, match_reason, briefing_status)
    VALUES (?, 'google', ?, ?, ?, ?, '[]', ?, 'manual', 'pending')
  `).run(
    userId,
    'TEST-PHASE7-evt-quiet-' + Date.now(),
    'Sync with prospect — TEST-PHASE7-Quiet incumbent',
    futureIso(28),
    futureIso(58),
    quietCompId,
  ).lastInsertRowid;
  ok(`fixture: tracked_meeting#${meetingId5} matched to ${F_QUIET}`);

  console.log('  → dispatching...');
  const meetingRow5 = db.prepare(`
    SELECT m.*, s.briefing_lead_minutes FROM tracked_meetings m LEFT JOIN settings s ON s.user_id = m.user_id WHERE m.id = ?
  `).get(meetingId5);
  const r5 = await dispatchOne(meetingRow5);
  console.log(`  dispatch result: ${JSON.stringify(r5)}`);

  if (r5.status === 'sent' && r5.channels?.includes('discord')) ok('Discord lighter-brief sent');
  else bad('Discord lighter-brief did NOT send', JSON.stringify(r5));
  if (r5.ai_usage === null || r5.ai_usage === undefined) ok('No Haiku call made (no change to condense — cost-correct)');
  else bad('Haiku was called for an empty-change brief', JSON.stringify(r5.ai_usage));

  const after5 = db.prepare("SELECT briefing_status, briefing_sent_at FROM tracked_meetings WHERE id = ?").get(meetingId5);
  if (after5.briefing_status === 'sent') ok(`DB briefing_status flipped to 'sent'`);
  else bad(`DB briefing_status is ${after5.briefing_status}`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══ TEST 7a: token refresh (happy path) ══');

  const conn = db.prepare("SELECT * FROM calendar_connections WHERE user_id = ? AND provider = 'google'").get(userId);
  if (!conn) { bad('no calendar_connection row — run OAuth first'); process.exit(1); }
  if (!conn.refresh_token_enc) { bad('no refresh_token stored — re-run OAuth'); process.exit(1); }

  const originalExpiresAt    = conn.expires_at;
  const originalAccessTokenEnc = conn.access_token_enc;
  console.log(`  before: expires_at=${conn.expires_at} (${Math.round((new Date(conn.expires_at).getTime() - Date.now())/60000)} min from now)`);
  // Force-expire
  db.prepare("UPDATE calendar_connections SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 5 * 60 * 1000).toISOString(), conn.id);
  console.log(`  forced expires_at to 5 min in the past`);

  try {
    const summary = await syncOneConnection({ userId, provider: 'google' });
    ok(`sync succeeded post-refresh: events_fetched=${summary.events_fetched} duration=${summary.duration_ms}ms`);
  } catch (e) {
    bad(`sync failed post-refresh: ${e.message}`);
  }

  const after7a = db.prepare("SELECT expires_at, access_token_enc, status, last_sync_error FROM calendar_connections WHERE id = ?").get(conn.id);
  const newExpMs = new Date(after7a.expires_at).getTime();
  const refreshed = newExpMs > Date.now() + 30 * 1000; // at least 30s in future
  if (refreshed) ok(`new expires_at in future: ${after7a.expires_at} (${Math.round((newExpMs - Date.now())/60000)} min ahead)`);
  else bad(`expires_at not refreshed: ${after7a.expires_at}`);
  if (after7a.access_token_enc !== originalAccessTokenEnc) ok('access_token_enc changed (new token stored)');
  else bad('access_token_enc unchanged — refresh did not actually rotate the token');
  if (after7a.status === 'active') ok(`status still 'active'`);
  else bad(`status is ${after7a.status}`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══ TEST 7b: expired-status fallback (broken refresh token) ══');

  // Back up the real refresh token; swap in a bogus one.
  const realRefreshEnc = db.prepare("SELECT refresh_token_enc FROM calendar_connections WHERE id = ?").get(conn.id).refresh_token_enc;
  const bogusRefreshEnc = encrypt('1//00bogus-refresh-token-will-be-rejected-by-google');
  db.prepare("UPDATE calendar_connections SET refresh_token_enc = ?, expires_at = ? WHERE id = ?")
    .run(bogusRefreshEnc, new Date(Date.now() - 5 * 60 * 1000).toISOString(), conn.id);
  console.log(`  swapped in bogus refresh token, expires_at forced to past`);

  let threwAsExpected = false;
  try {
    await syncOneConnection({ userId, provider: 'google' });
    bad('sync did NOT throw with bogus refresh — expected refresh failure');
  } catch (e) {
    threwAsExpected = true;
    ok(`sync threw as expected: ${e.message.slice(0, 80)}`);
  }

  const after7b = db.prepare("SELECT status, last_sync_error FROM calendar_connections WHERE id = ?").get(conn.id);
  if (after7b.status === 'expired') ok(`status flipped to 'expired'`);
  else bad(`status is ${after7b.status} — expected 'expired'`);
  if (after7b.last_sync_error) ok(`last_sync_error captured: ${after7b.last_sync_error.slice(0, 80)}`);
  else bad('last_sync_error not captured');

  // RESTORE — critical so the user's real OAuth state survives this test.
  db.prepare("UPDATE calendar_connections SET refresh_token_enc = ?, status = 'active', last_sync_error = NULL WHERE id = ?")
    .run(realRefreshEnc, conn.id);
  // Re-run a sync to verify restore worked and refresh a fresh access token.
  try {
    await syncOneConnection({ userId, provider: 'google' });
    ok('restore verified: real refresh token works again, status back to active');
  } catch (e) {
    bad(`RESTORE FAILED — user may need to re-OAuth: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
  console.log(`Fixtures left in DB:`);
  console.log(`  - competitor "${F_RECENT}" (#${recentCompId}) + 1 change + 1 meeting`);
  console.log(`  - competitor "${F_QUIET}" (#${quietCompId}) + 1 stale change + 1 meeting`);
  console.log(`Run cleanup at the end with: node test-phase7-cleanup.js`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('\nRUNNER CRASHED:', err);
  process.exit(1);
});
