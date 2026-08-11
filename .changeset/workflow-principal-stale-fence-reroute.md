---
"@runfusion/fusion": patch
---

summary: Fix four stalls that left tasks stuck for hours with no retry and no visible error.
category: fix
dev: |
  Workflow principal routing separates structural capability from availability. A named principal that can
  never satisfy a node (wrong role, deleted, authority edited away) is no longer authority for it — routing
  falls through to the column binding and role pool, and a resumed continuation discards the stale fence and
  re-routes. A role-capable principal that is only paused/disabled/at capacity still holds. An explicitly
  assigned engineer-role agent is now valid `task-assignee` authority for an executor node; the role pool
  stays strict. An unresolvable node instance or absent IR still fails closed rather than re-routing.

  Dependency auto-unblock (`scheduler.ts` plus the three `self-healing.ts` sites) now clears only the `queued`
  marker it owns instead of nulling any status, so a `needs-replan` signal survives a blocker completing.

  New self-healing sweep `reconcilePrincipalHeldPlanningContinuations` re-queues planning for a card stranded
  on a principal-routing hold, gated on the planning lane, effective auto-merge, an owned (null) status, and
  the planning lifecycle lock. Emits `task:reconcile-principal-held-planning[-no-action]`.

  Workflow node-instance-id materialization is idempotent for foreach, loop, and optional-group containers;
  it previously re-wrapped its own output each dispatch, growing the persisted `run_id` without bound.
