# Phase 10.5 prerequisites

## 1. HARD PREREQUITE — convert `user_id`-scoped reads to `workspace_id`-scoped reads

**Before any Phase 10.5 (multi-user workspace) work begins, convert all
`user_id`-scoped reads of workspace-owned tables to `workspace_id`-scoped reads.
Estimated 2–3 hours. This is a hard prerequisite — not optional.**

### Why

Phase 10 deliberately kept existing reads scoped by `user_id`. That is correct
*only* because Phase 10 enforces a 1:1 invariant (every user owns exactly one
workspace). Writes already populate `workspace_id` (via the `AFTER INSERT`
triggers in `src/db.js`), and gating + new code are workspace-scoped — but the
reads still filter by `user_id`.

The moment Phase 10.5 introduces multi-member workspaces, this breaks:

> A workspace **member** (not the owner) querying by their own `user_id` will
> NOT see workspace-owned data created by the owner or other members, because
> those rows carry the *owner's* `user_id`. They should see it — it belongs to
> the shared workspace.

So every read of a workspace-owned table must change from
`WHERE user_id = <currentUser>` to `WHERE workspace_id = <currentWorkspace>`,
using `req.workspaceId` (already set on every authenticated request by
`attachWorkspace` in `src/server.js`) or `getUserCurrentWorkspace()` /
the future session active-workspace resolver.

### Scope

**Convert (workspace-owned tables):** `competitors`, `deals`,
`generated_playbooks`, `tracked_meetings`, `calendar_connections`,
`slack_installations`, `correlations`, `pattern_alerts`.

**Do NOT convert (genuinely personal, stay `user_id`-scoped):** `user_context`,
`user_voice_profile`, `settings`, `users`, `otp_codes`, `login_attempts`,
`sessions`, and `audit_log.user_id` (per-actor attribution).

### Files and reads to convert (audited 2026-05-31)

| File | What to convert |
|---|---|
| `src/routes/competitors.js` | List + per-id ownership reads (`SELECT ... FROM competitors WHERE id = ? AND user_id = ?`, the list query, history reads). Switch to `workspace_id`. |
| `src/routes/changes.js` | `total_competitors` / `active_competitors` counts (`FROM competitors WHERE user_id = ?`). |
| `src/routes/calendar.js` | `calendar_connections` list/lookup/delete by `user_id`; `tracked_meetings` by `user_id`; competitor-ownership checks. |
| `src/routes/roi.js` | Competitor-ownership check; `pattern_alerts` delete by `user_id`. |
| `src/routes/playbooks.js` | `userOwnsPlaybook` (`generated_playbooks ... user_id`) and `userOwnsChange` (joins `competitors.user_id`). |
| `src/routes/slack.js` | `competitors WHERE user_id`; note the Slack-identity→`user_id` mapping must resolve to a workspace (an installer acts within a workspace). |
| `src/deals.js` | All `deals` and competitor-ownership reads/deletes by `user_id`. |
| `src/correlationEngine.js` | Heaviest: `deals`, `correlations`, `competitors`, `pattern_alerts` all read/written by `user_id`. The whole engine should key on `workspace_id`. |
| `src/historicalContext.js` | `getCompetitorHistory(..., { userId })` joins `competitors.user_id` for tenant scoping — change the scoping key to `workspace_id`. |
| `src/playbooks.js` | History + playbook reads keyed by `user_id`. |
| `src/calendarSync.js` | `tracked_meetings` / `calendar_connections` by `user_id`. |
| `src/briefingDispatch.js` | Meeting/connection reads by `user_id`. |
| `src/scheduler.js` | Gating already workspace-scoped; remaining per-row reads (settings lookup is fine — personal) should be reviewed. |

### Suggested approach

1. Add a `workspaceId` parameter to the service-layer functions
   (`correlationEngine`, `historicalContext`, `playbooks`, `deals`,
   `calendarSync`, `briefingDispatch`) and thread `req.workspaceId` through the
   routes.
2. Replace `WHERE user_id = ?` with `WHERE workspace_id = ?` on the
   workspace-owned tables; keep `user_id` only where the row is genuinely
   per-actor (e.g. "who logged this deal").
3. Re-run `node scripts/verify-workspace-integrity.js` and add a test that a
   second workspace member sees the owner's data.

This is the literal **first task** of Phase 10.5.

---

## 2. Other Phase 10.5 follow-ups (lower priority)

- Replace `getUserCurrentWorkspace()` (always personal workspace) with a
  session-based active-workspace resolver; add `workspace_members` rows with
  `admin`/`member` roles via an invite flow.
- Make `getUserRole()` return real roles and gate owner-only actions
  (billing, member management, account deletion of the workspace).
- Remove the deprecated `users.tier` column (post-launch cleanup; see the
  comment in `src/db.js`).
