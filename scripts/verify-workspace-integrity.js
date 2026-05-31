#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Workspace integrity gate — RUN BEFORE ANY DEPLOY.
//
// Scans every workspace-scoped table for rows missing a workspace_id (the
// invariant the Phase 10 migration establishes but SQLite cannot enforce as a
// hard NOT NULL constraint without a full table rebuild). Read-only: it opens
// the DB file directly and never mutates or runs migrations/seeds.
//
//   exit 0  → all clean, safe to deploy (prints a per-table summary)
//   exit 1  → orphaned rows found OR a table is missing workspace_id / DB absent
//
// Usage: node scripts/verify-workspace-integrity.js
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// Must match MIGRATED_TABLES in src/db.js. `changes` is intentionally excluded:
// it is workspace-scoped only transitively via competitor_id → competitors.
const WORKSPACE_SCOPED = [
  'competitors', 'generated_playbooks', 'deals',
  'tracked_meetings', 'calendar_connections', 'slack_installations',
  'correlations', 'pattern_alerts',
];

(async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '..', 'data', 'competitor-shadow.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`❌ Database not found at ${dbPath}`);
    process.exit(1);
  }

  const db = new SQL.Database(fs.readFileSync(dbPath));
  const scalar = (sql) => {
    const r = db.exec(sql);
    return r[0] ? Number(r[0].values[0][0]) : 0;
  };

  const problems = [];
  const summary = [];

  for (const t of WORKSPACE_SCOPED) {
    const cols = (db.exec(`PRAGMA table_info(${t})`)[0]?.values || []).map(v => v[1]);
    if (!cols.length) { problems.push(`${t}: table is MISSING`); continue; }
    if (!cols.includes('workspace_id')) { problems.push(`${t}: MISSING workspace_id column`); continue; }
    const total = scalar(`SELECT COUNT(*) FROM ${t}`);
    const nulls = scalar(`SELECT COUNT(*) FROM ${t} WHERE workspace_id IS NULL`);
    summary.push(`  ${t.padEnd(22)} total=${String(total).padStart(4)}  null=${nulls}  ${nulls === 0 ? '✅' : '❌'}`);
    if (nulls > 0) problems.push(`${t}: ${nulls} row(s) with NULL workspace_id`);
  }

  console.log(`Workspace integrity scan — ${WORKSPACE_SCOPED.length} workspace-scoped tables:`);
  summary.forEach(s => console.log(s));

  if (problems.length) {
    console.error('\n❌ INTEGRITY FAILURES — DO NOT DEPLOY:');
    problems.forEach(p => console.error(`  - ${p}`));
    process.exit(1);
  }

  console.log('\n✅ All workspace-scoped tables clean. Safe to deploy.');
  process.exit(0);
})().catch(e => { console.error('SCAN ERROR:', e); process.exit(1); });
