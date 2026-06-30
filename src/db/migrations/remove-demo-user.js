// ─────────────────────────────────────────────────────────────────────────────
// One-time production cleanup: remove a leaked DEMO USER account.
//
// BACKGROUND
//   The seeded demo account (id 1, "Demo User") is a DEV-ONLY convenience created
//   by seedDemoData() in src/db.js. Demo-user creation was UNGATED until commit
//   b55a627 (Phase 12A, the Railway-deployment-prep commit), which wrapped the
//   creation in `if (NODE_ENV !== 'production')`. Because that gate landed as part
//   of the first deployment prep, evidence indicates no demo user was ever seeded
//   into the live database: the Phase 9 deal-seed leak (fixed the day after, in
//   ab265f1) attached its 18 fake deals to user_id 1 = the first REAL signup,
//   which is only possible if demo-user creation was already gated.
//
//   This migration is a DEFENSIVE, idempotent safety net: if a demo-signature
//   user somehow exists in production (e.g. an early pre-gate boot), it is removed
//   with the same safe cascade the in-app account-deletion uses. If none exists
//   (the expected case) it is a guaranteed no-op on every boot.
//
// SAFETY MODEL
//   • Match ONLY by an exact, known demo-seed email. These are addresses on our
//     own domains that the seed has ever used; a real customer never owns one.
//   • AMBIGUITY GUARD: if a matched account owns a workspace with a real linked
//     subscription (subscription_id IS NOT NULL), it is treated as a possible real
//     paying account and SKIPPED with a warning — never deleted.
//   • Deletion reuses purgeUser() from routes/account.js: one atomic savepoint,
//     payment_events retained/anonymized, no orphaned rows.
//   • Production-only: returns immediately when NODE_ENV !== 'production' so local
//     dev keeps its demo login. Tests may force-run via opts.force.
//   • Idempotent: after the first run the email signatures match nothing, so
//     subsequent boots delete zero rows. Same "safe on every boot" convention as
//     removePhase9DemoData().
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Exact demo-seed emails ever used by seedDemoData() across the project's brand
// history (Competitor Shadow, Foresight, Nivaria). Matched verbatim — a real user
// would not own one of these addresses.
const DEMO_USER_EMAILS = [
  'demo@competitor-shadow.com',
  'demo@foresight.com',
  'demo@nivaria.app',
];

/**
 * Remove a leaked demo-user account from the live database.
 *
 * @param {object} db   The DatabaseWrapper from src/db.js (prepare/savepoint).
 * @param {object} [opts]
 * @param {boolean} [opts.force]   Run regardless of NODE_ENV (tests only).
 * @param {object}  [opts.log]     Logger ({log, warn}); defaults to console.
 * @returns {{users:number, skipped:number}}
 */
function removeDemoUser(db, opts = {}) {
  const log = opts.log || console;
  const result = { users: 0, skipped: 0 };

  if (!opts.force && process.env.NODE_ENV !== 'production') {
    return result; // dev/test DBs keep their demo login
  }

  // Reuse the in-app account-deletion cascade. Required lazily (not at module
  // load) so db.js -> this migration -> account.js -> db.js cannot deadlock the
  // module graph: by the time this runs during initDb(), db.js is fully loaded.
  const { purgeUser } = require('../../routes/account');

  for (const email of DEMO_USER_EMAILS) {
    const rows = db.prepare('SELECT id, email, created_at FROM users WHERE email = ?').all(email);
    for (const row of rows) {
      // AMBIGUITY GUARD — never delete an account that looks like a real paying
      // customer, even if it carries a demo-signature email.
      const paid = db.prepare(
        'SELECT 1 FROM workspaces WHERE owner_user_id = ? AND subscription_id IS NOT NULL LIMIT 1'
      ).get(row.id);
      if (paid) {
        result.skipped++;
        log.warn(`[CLEANUP] SKIP: user #${row.id} <${row.email}> matches a demo ` +
          `signature but owns a workspace with a real subscription — treating as ` +
          `a real account, not deleting.`);
        continue;
      }

      log.log(`[CLEANUP] Demo user identified: user #${row.id} <${row.email}> ` +
        `(created_at=${row.created_at}). Removing with full account cascade.`);
      purgeUser(db, row.id, row.email);
      result.users++;
    }
  }

  if (result.users === 0) {
    log.log('[CLEANUP] No demo user found — nothing to remove.' +
      (result.skipped ? ` (${result.skipped} ambiguous account(s) skipped.)` : ''));
  } else {
    log.log(`[CLEANUP] Demo user cleanup complete: ${result.users} account(s) removed.` +
      (result.skipped ? ` ${result.skipped} ambiguous account(s) skipped.` : ''));
  }

  return result;
}

module.exports = { removeDemoUser, DEMO_USER_EMAILS };
