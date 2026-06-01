// Test 11 part B — simulate 30 days elapsing, run the deletion cron, verify
// hard-delete + payment_events retained-but-anonymized. RUN WITH SERVER STOPPED.
const fs = require('fs');
const path = require('path');
const tw = JSON.parse(fs.readFileSync(path.join(__dirname, '.throwaway.json'), 'utf8'));
const { initDb, getDb } = require('../src/db');
const account = require('../src/routes/account');

(async () => {
  await initDb();
  const db = getDb();
  const scalar = (sql, ...a) => Object.values(db.prepare(sql).get(...a) || { n: 0 })[0];

  // Seed a synthetic payment_events row for the throwaway's workspace so we can
  // prove retention+anonymization (the throwaway never really subscribed).
  const synthId = 'test11-synth-' + Date.now();
  db.prepare("INSERT INTO payment_events (workspace_id, lemon_squeezy_event_id, event_type, payload, status) VALUES (?, ?, 'subscription_payment_success', '{}', 'processed')").run(tw.workspaceId, synthId);

  console.log('BEFORE deletion:');
  console.log('  user exists:', scalar('SELECT COUNT(*) n FROM users WHERE id=?', tw.userId));
  console.log('  workspace exists:', scalar('SELECT COUNT(*) n FROM workspaces WHERE id=?', tw.workspaceId));
  console.log('  competitors in ws:', scalar('SELECT COUNT(*) n FROM competitors WHERE workspace_id=?', tw.workspaceId));
  console.log('  workspace_members:', scalar('SELECT COUNT(*) n FROM workspace_members WHERE workspace_id=?', tw.workspaceId));
  console.log('  synthetic payment_events workspace_id:', JSON.stringify(db.prepare('SELECT workspace_id FROM payment_events WHERE lemon_squeezy_event_id=?').get(synthId)));

  // Simulate 30 days passing.
  db.prepare("UPDATE users SET deletion_scheduled_at='2000-01-01 00:00:00' WHERE id=?").run(tw.userId);

  // Run the cron.
  const n = account.processScheduledDeletions();
  console.log(`\nprocessScheduledDeletions() deleted ${n} account(s)\n`);

  // Verify hard-delete.
  const userGone = scalar('SELECT COUNT(*) n FROM users WHERE id=?', tw.userId) === 0;
  const wsGone = scalar('SELECT COUNT(*) n FROM workspaces WHERE id=?', tw.workspaceId) === 0;
  const memGone = scalar('SELECT COUNT(*) n FROM workspace_members WHERE workspace_id=?', tw.workspaceId) === 0;
  const compGone = scalar('SELECT COUNT(*) n FROM competitors WHERE workspace_id=?', tw.workspaceId) === 0;
  console.log('AFTER deletion:');
  console.log(`  user gone: ${userGone ? '✅' : '❌'}`);
  console.log(`  workspace gone: ${wsGone ? '✅' : '❌'}`);
  console.log(`  workspace_members gone: ${memGone ? '✅' : '❌'}`);
  console.log(`  competitors gone: ${compGone ? '✅' : '❌'}`);

  // payment_events retained + anonymized.
  const pe = db.prepare('SELECT workspace_id FROM payment_events WHERE lemon_squeezy_event_id=?').get(synthId);
  const retainedAnon = pe && (pe.workspace_id === null || pe.workspace_id === undefined);
  console.log(`  payment_events row retained: ${pe ? '✅' : '❌'}; workspace_id anonymized to NULL: ${retainedAnon ? '✅' : '❌ (' + JSON.stringify(pe) + ')'}`);

  // audit completed.
  const completed = scalar("SELECT COUNT(*) n FROM audit_log WHERE event_type='account_deletion_completed' AND user_id=?", tw.userId) >= 1;
  console.log(`  account_deletion_completed audit logged: ${completed ? '✅' : '❌'}`);

  // demo (paid account) untouched?
  const demoOk = scalar("SELECT COUNT(*) n FROM workspaces WHERE id=1 AND subscription_tier='pro'") === 1;
  console.log(`  demo workspace untouched (still pro): ${demoOk ? '✅' : '❌'}`);

  const pass = userGone && wsGone && memGone && compGone && retainedAnon && completed && demoOk;
  console.log(`\nTEST 11 (Part B): ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  // clean up the synthetic test payment_events row (it's purely a test artifact).
  db.prepare('DELETE FROM payment_events WHERE lemon_squeezy_event_id=?').run(synthId);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
