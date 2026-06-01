// Test 9 — workspace migration integrity (read-only).
const fs = require('fs');
const path = require('path');
const MIGRATED = ['competitors', 'generated_playbooks', 'deals', 'tracked_meetings', 'calendar_connections', 'slack_installations', 'correlations', 'pattern_alerts'];

(async () => {
  const SQL = await require('sql.js')();
  const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
  const n = (sql) => { const r = db.exec(sql); return r[0] ? Number(r[0].values[0][0]) : 0; };
  const checks = [];

  const users = n('SELECT COUNT(*) FROM users');
  const owners = n("SELECT COUNT(DISTINCT owner_user_id) FROM workspaces");
  const ws = n('SELECT COUNT(*) FROM workspaces');
  const multi = n('SELECT COUNT(*) FROM (SELECT owner_user_id FROM workspaces GROUP BY owner_user_id HAVING COUNT(*) > 1)');
  console.log(`users=${users} workspaces=${ws} distinct-owners=${owners} owners-with-multiple-ws=${multi}`);
  console.log(`  every user has exactly one personal workspace: ${users === owners && ws === owners && multi === 0 ? 'YES ✅' : 'NO ❌'}`);
  checks.push(users === owners && ws === owners && multi === 0);

  let orphans = 0, mismatches = 0;
  for (const t of MIGRATED) {
    const nulls = n(`SELECT COUNT(*) FROM ${t} WHERE workspace_id IS NULL`);
    const mm = n(`SELECT COUNT(*) FROM ${t} r JOIN workspaces w ON w.id=r.workspace_id WHERE w.owner_user_id != r.user_id`);
    orphans += nulls; mismatches += mm;
    console.log(`  ${t.padEnd(22)} null=${nulls} ownerMismatch=${mm} ${nulls === 0 && mm === 0 ? '✅' : '❌'}`);
  }
  console.log(`  no orphaned rows: ${orphans === 0 ? 'YES ✅' : 'NO ❌'}; ownership consistent: ${mismatches === 0 ? 'YES ✅' : 'NO ❌'}`);
  checks.push(orphans === 0 && mismatches === 0);

  // changes are reachable via competitor → workspace (no change whose competitor lacks a workspace)
  const changeOrphans = n('SELECT COUNT(*) FROM changes ch JOIN competitors c ON c.id=ch.competitor_id WHERE c.workspace_id IS NULL');
  console.log(`  changes with workspace-less parent competitor: ${changeOrphans} ${changeOrphans === 0 ? '✅' : '❌'}`);
  checks.push(changeOrphans === 0);

  // tier note (free-at-migration was verified at checkpoint 1; now reflects test activity)
  const tiers = db.exec('SELECT subscription_tier, COUNT(*) FROM workspaces GROUP BY subscription_tier')[0];
  console.log('  current workspace tiers:', tiers ? tiers.values.map(v => `${v[0]}=${v[1]}`).join(' ') : 'none', '(all-free verified at checkpoint 1; reflects test subscriptions now)');

  console.log(`\nTEST 9: ${checks.every(Boolean) ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
