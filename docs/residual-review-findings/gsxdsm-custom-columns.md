# Residual Review Findings — `gsxdsm/custom-columns`

Source: `ce-code-review mode:autofix` run `20260604-021808-25e15199` (13 reviewers + 9 validators) against merge-base `962b97ce8`, plan `docs/plans/2026-06-03-003-feat-workflow-custom-columns-traits-plan.md`. 14 safe fixes were applied and committed (`30e2fd7b0`); the findings below were filed as tracked issues and have ALL been fixed on this branch (commits 571768f03..afc72b6bb); the issues close when PR #1418 merges (Fixes references in the PR body).

## Residual Review Findings

- [P1] `packages/core/src/transition-pending.ts:39` — Implement transitionPending recovery sweep (markers leak capacity slots after crash) — [#1401](https://github.com/Runfusion/Fusion/issues/1401)
- [P1] `packages/engine/src/hold-release.ts:98` — Consolidate 4 copies of the workflow-IR resolution rule — [#1402](https://github.com/Runfusion/Fusion/issues/1402)
- [P1] `packages/core/src/store.ts:5697` — Widen moveTaskInternal/Task.column to ColumnId (type-honesty refactor) — [#1403](https://github.com/Runfusion/Fusion/issues/1403)
- [P1] `packages/dashboard/src/routes/register-task-workflow-routes.ts:1414` — Add route-level tests for POST /tasks/:id/promote — [#1404](https://github.com/Runfusion/Fusion/issues/1404)
- [P1] `packages/core/src/workflow-ir.ts:245` — WorkflowIr v2 persistence breaks rollback to pre-v2 binaries — [#1405](https://github.com/Runfusion/Fusion/issues/1405)
- [P1] `packages/dashboard/src/routes/register-workflow-routes.ts` — Emit workflow:updated SSE event; invalidate boardWorkflows on workflow edits — [#1406](https://github.com/Runfusion/Fusion/issues/1406)
- [P1] `packages/engine/src/workflow-graph-task-runner.ts` — Wire SQLite branch persistence for fan-out runs in production — [#1407](https://github.com/Runfusion/Fusion/issues/1407)
- [P1] `packages/engine/src/agent-tools.ts` — Agent-native parity: fn_task_promote, reconcile-aware fn_workflow_select, workflow CRUD, trait catalog — [#1408](https://github.com/Runfusion/Fusion/issues/1408)
- [P1] `packages/core/src/store.ts` — Define flag ON→OFF evacuation policy for cards in custom columns — [#1409](https://github.com/Runfusion/Fusion/issues/1409)
- [P2] `packages/dashboard/app/components/Column.tsx:193` — Clear inline capacity feedback when column tasks change via SSE — [#1410](https://github.com/Runfusion/Fusion/issues/1410)
- [P2] `packages/engine/src/self-healing.ts` — Recovery moves on custom workflows can be rejected by order-derived adjacency (use `recoveryRehome`) — [#1411](https://github.com/Runfusion/Fusion/issues/1411)
- [P2] `packages/core/src/db.ts:581` — Prune workflow_run_branches per run (unbounded growth) — [#1412](https://github.com/Runfusion/Fusion/issues/1412)
- [P2] `packages/core/src/store.ts:5039` — Filter branch-progress JOIN to the latest run in SQL — [#1413](https://github.com/Runfusion/Fusion/issues/1413)
- [P2] `packages/dashboard/src/routes/register-task-workflow-routes.ts:816` — Add HTTP integration test for GET /tasks/board-workflows — [#1414](https://github.com/Runfusion/Fusion/issues/1414)
- [P2] `packages/engine/src/hold-release.ts` — Add concurrent-sweep safety test (overlapping runHoldReleaseSweep) — [#1415](https://github.com/Runfusion/Fusion/issues/1415)
- [P2] `packages/dashboard/app/components/Board.tsx:354` — Test canDropTask pre-check branches at Board level — [#1416](https://github.com/Runfusion/Fusion/issues/1416)
- [P3] `packages/core/src/__tests__/db-migrate.test.ts` — Add v105→106/107 forward-path migration tests — [#1417](https://github.com/Runfusion/Fusion/issues/1417)

## Advisory (report-only, no ticket)

- [P2] `packages/core/src/store.ts` — store.ts grew ~1k lines; extract the flag-OFF legacy effects block for symmetry (maintainability)
- [P2] `packages/core/src/db.ts:4237` — applyMigration is non-transactional; the ALTER TABLE justification comment doesn't apply to DDL-only migration 107 (data-migration)
- [P2] `packages/core/src/store.ts:12192` — integrity pass silently re-homes; add a WARNING log or dry-run preview (data-migration)
- [P3] `packages/engine/src/hold-release.ts:304` — sweep countPending pre-check branch is dead (Task lacks transitionPending); authoritative in-txn count unaffected (correctness)
- [P3] `packages/core/src/store.ts:5771` — getSettingsFast awaited per move; consider a short-TTL settings cache (performance)
- Note: blocking *plugin* gate verdicts currently always reject (fail-closed) — `recordPluginGateVerdict` has no production caller yet; wire it when plugin gates ship end-to-end (security)
