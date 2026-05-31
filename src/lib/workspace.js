// Phase 10 — workspace resolution helpers.
//
// Every user owns exactly one personal workspace (user_id ↔ workspace_id is
// 1:1 in Phase 10). These helpers are the single source of truth for "which
// workspace is this user acting in" and "what role do they hold", so Phase 10.5
// (real multi-member teams + a session-based active workspace) becomes a
// localized change here rather than a codebase-wide refactor.

const { getDb } = require('../db');

// The workspace the user is currently acting in.
//   Phase 10:  always their owned personal workspace.
//   Phase 10.5: will consult session.activeWorkspaceId, falling back to this.
function getUserCurrentWorkspace(userId) {
  if (!userId) return null;
  return getDb().prepare(
    'SELECT * FROM workspaces WHERE owner_user_id = ? ORDER BY id ASC LIMIT 1'
  ).get(userId) || null;
}

function getWorkspaceById(workspaceId) {
  if (!workspaceId) return null;
  return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) || null;
}

// 'owner' | 'admin' | 'member' | null.
//   Phase 10: 'owner' for the user's own workspace, null for any other.
function getUserRole(userId, workspaceId) {
  if (!userId || !workspaceId) return null;
  const row = getDb().prepare(
    'SELECT role FROM workspace_members WHERE user_id = ? AND workspace_id = ?'
  ).get(userId, workspaceId);
  return row ? row.role : null;
}

module.exports = { getUserCurrentWorkspace, getWorkspaceById, getUserRole };
