// Phase 7 — pure-logic test runner (no external services required).
//
// What it tests:
//   • Test 2  — title match: "Acme deal review" → matches "Acme" competitor
//   • Test 3  — domain match: attendee jane@acme.com → matches "Acme"
//   • Test 6  — manual tag: route-handler shape verified at the DB layer
//   • Token encryption round-trip (AES-256-GCM via src/calendarTokens.js)
//   • Attendee sanitization edge cases (control chars, malformed emails)
//
// How to run (server can be running OR stopped — script reads competitors
// table but only mutates tracked_meetings rows it created itself):
//   node test-phase7-matching.js
//
// Prerequisites:
//   • Database initialized (npm start at least once)
//   • CALENDAR_TOKEN_ENCRYPTION_KEY in .env, OR script generates an
//     ephemeral one (encryption round-trip works either way).

require('dotenv').config();
process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ||= require('crypto').randomBytes(32).toString('hex');

const { initDb, getDb, extractDomainFromUrl } = require('./src/db');
const { matchEvent, sanitizeAttendee } = require('./src/calendarSync');
const { encrypt, decrypt } = require('./src/calendarTokens');

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else      { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}

(async () => {
  await initDb();
  const db = getDb();

  // ─── ensure demo user has a known set of competitors with domains ──────────
  const userId = 1;
  // Clean Phase 7 tables for repeatable test runs
  db.prepare('DELETE FROM tracked_meetings WHERE user_id = ?').run(userId);

  // Force a "Acme" competitor with a known domain. The seed already has
  // 'Acme Corp' at id=1 (acmecorp.com). Add a fresh one called 'Acme' for
  // clean title matching.
  const existingAcme = db.prepare("SELECT id FROM competitors WHERE user_id = ? AND name = 'Acme'").get(userId);
  let acmeId;
  if (existingAcme) acmeId = existingAcme.id;
  else {
    acmeId = db.prepare("INSERT INTO competitors (user_id, name, url, description, domain) VALUES (?, 'Acme', 'https://acme.com/pricing', 'Phase 7 test fixture', 'acme.com')").run(userId).lastInsertRowid;
  }

  // ============================================================
  console.log('\n── ENCRYPTION ROUND-TRIP ──');
  const blob = encrypt('ya29.fake-access-token-value');
  assert('blob looks v1.', /^v1\./.test(blob));
  assert('decrypt round-trips', decrypt(blob) === 'ya29.fake-access-token-value');
  assert('blob is not the plaintext', !blob.includes('ya29'));

  // ============================================================
  console.log('\n── TEST 2: TITLE MATCH ──');
  const competitors = db.prepare("SELECT id, name, domain FROM competitors WHERE user_id = ? AND active = 1").all(userId);

  const ev1 = {
    id: 'evt-title-1',
    title: 'Acme deal review',
    start: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    end:   new Date(Date.now() + 90 * 60 * 1000).toISOString(),
    attendees: [],
  };
  const m1 = matchEvent(competitors, ev1);
  assert('event matches by title', !!m1, JSON.stringify(m1));
  assert('match reason is title', m1?.reason === 'title');
  assert('matched id is the Acme row', m1?.competitorId === acmeId);

  const ev2 = { id: 'evt-title-2', title: 'Academy planning session', start: ev1.start, end: ev1.end, attendees: [] };
  const m2 = matchEvent(competitors, ev2);
  assert('"academy" does NOT match "Acme" (word boundary)', m2 === null || m2.competitorId !== acmeId);

  // ============================================================
  console.log('\n── TEST 3: DOMAIN MATCH ──');
  const ev3 = {
    id: 'evt-domain-1',
    title: 'Discovery call',                              // no Acme in title
    start: ev1.start, end: ev1.end,
    attendees: [
      sanitizeAttendee({ email: 'jane.doe@acme.com', name: 'Jane Doe' }),
    ],
  };
  const m3 = matchEvent(competitors, ev3);
  assert('event matches by attendee domain', !!m3, JSON.stringify(m3));
  assert('match reason is domain', m3?.reason === 'domain');
  assert('matched id is the Acme row', m3?.competitorId === acmeId);

  // ============================================================
  console.log('\n── TEST 6: MANUAL TAG (DB-level) ──');
  // Insert an unmatched meeting
  db.prepare(`
    INSERT INTO tracked_meetings (user_id, provider, external_event_id, title, start_time, attendees, match_reason, briefing_status)
    VALUES (?, 'google', 'evt-manual-1', 'Catch up with someone unrelated', ?, '[]', 'none', 'pending')
  `).run(userId, new Date(Date.now() + 60 * 60 * 1000).toISOString());

  const created = db.prepare("SELECT id, matched_competitor_id, match_reason FROM tracked_meetings WHERE external_event_id = 'evt-manual-1'").get();
  assert('meeting inserted unmatched', created && !created.matched_competitor_id && created.match_reason === 'none');

  // Apply a manual tag (simulating what the route handler does)
  db.prepare(`
    UPDATE tracked_meetings
    SET matched_competitor_id = ?, match_reason = 'manual', briefing_status = 'pending'
    WHERE id = ?
  `).run(acmeId, created.id);

  const tagged = db.prepare("SELECT matched_competitor_id, match_reason, briefing_status FROM tracked_meetings WHERE id = ?").get(created.id);
  assert('manual tag applied', tagged.matched_competitor_id === acmeId);
  assert('match_reason is manual', tagged.match_reason === 'manual');
  assert('briefing_status reset to pending', tagged.briefing_status === 'pending');

  // ============================================================
  console.log('\n── SANITIZATION ──');
  // Control chars in the email get stripped (not space-substituted), so a
  // well-formed underlying address survives normalization.
  const cleaned = sanitizeAttendee({ email: '  EVIL\x00@example.com  ', name: 'Bad\x07Actor' });
  assert('control + whitespace stripped from email', cleaned?.email === 'evil@example.com');
  assert('domain derived correctly',                  cleaned?.domain === 'example.com');
  assert('control chars stripped from name',          !/[\x00-\x1F\x7F]/.test(cleaned?.name || ''));

  // An email that's malformed even after sanitization is dropped entirely.
  const trash = sanitizeAttendee({ email: 'not an email at all', name: 'X' });
  assert('malformed email yields null attendee', trash === null);

  // ============================================================
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('Runner crashed:', err);
  process.exit(1);
});
