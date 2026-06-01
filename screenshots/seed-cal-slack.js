// One-off: seed a fake calendar_connection + slack_installation into ws#1 so
// Test 10 can prove token masking in the export. RUN WITH SERVER STOPPED.
// (Removed again by cleanup-tests.js before the final commit.)
const { initDb, getDb } = require('../src/db');
(async () => {
  await initDb();
  const db = getDb();
  // workspace_id is auto-set from user_id by the AFTER INSERT trigger.
  if (!db.prepare("SELECT 1 FROM calendar_connections WHERE account_email='demo-fake@gcal.test'").get()) {
    db.prepare(`INSERT INTO calendar_connections (user_id, provider, account_email, access_token_enc, refresh_token_enc, status)
      VALUES (1, 'google', 'demo-fake@gcal.test', 'v1.FAKEENC.AT', 'v1.FAKEENC.RT', 'active')`).run();
  }
  if (!db.prepare("SELECT 1 FROM slack_installations WHERE slack_team_id='T_FAKE_TEST10'").get()) {
    db.prepare(`INSERT INTO slack_installations (user_id, slack_team_id, slack_team_name, slack_user_id, bot_token_enc, status)
      VALUES (1, 'T_FAKE_TEST10', 'FakeTeam', 'U_FAKE', 'v1.FAKEBOT.ENC', 'active')`).run();
  }
  console.log('seeded fake calendar_connection + slack_installation for ws#1');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
