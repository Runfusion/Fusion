# Triage Duplicate Detection Post-Mortem (FN-4774)

## Summary
Between 14:29 and 16:05 on 2026-05-16, three independent tasks were filed and executed for the same defect: rebase-merge done-task diff truncation in `packages/dashboard/src/routes/register-session-diff-routes.ts` (with related tests in `packages/dashboard/src/__tests__/routes-diff.test.ts`). This duplicated implementation and review effort.

## Timeline
- **FN-4726**
  - Created: **14:29**
  - Merged: **14:52**
  - GitHub tracking: **#400**
  - Scope touched: `register-session-diff-routes.ts`, `routes-diff.test.ts`
- **FN-4734**
  - Created: **14:54**
  - Finalization: **15:33** (auto no-op finalize)
  - GitHub tracking: **#414**
  - Scope touched: same target files
- **FN-4741**
  - Created: **15:04**
  - Merged: **16:05**
  - GitHub tracking: **#424**
  - Scope touched: same target files

## Root cause
1. **Triage duplicate scan blind spot:** `fn_task_list` intentionally excludes `done` tasks (`tasks.filter((t) => t.column !== "done")` in `packages/engine/src/triage.ts`), so recently completed fixes were invisible to the duplicate check.
2. **No triage keyword search tool:** Triage had no exposed keyword search over full task history (including done/archived), despite `TaskStore.searchTasks(...)` already existing and backed by FTS5.
3. **GitHub issue duplication gap:** Tracking issue creation did not include a check for existing closed issues covering the same files/keywords.

## Decision
1. **Add `fn_task_search` triage tool** that wraps `store.searchTasks(...)` with defaults that include historical tasks (`includeArchived: true`, done tasks included by default).
2. **Strengthen duplicate-check prompt guidance** so triage must run both list and keyword search (multiple phrases from title/description/file paths/symptoms/symbol names), then inspect likely matches before filing.
3. **Record GitHub-side dedup as follow-up work** (new task) rather than expanding this fix’s scope.

## Acceptance-criteria mapping
1. **Document what happened and why:** covered by timeline + root-cause analysis above.
2. **Close triage duplicate-detection gap:** addressed by adding `fn_task_search` and prompt instructions to query done/archived history.
3. **Preserve scope discipline:** GitHub-side dedup is explicitly deferred into a follow-up task instead of being implemented here.

## Incident closure (FN-4866)
FN-4866 was filed as a follow-up investigation request for the same FN-4726/FN-4734 duplicate-merge incident and is now closed against previously shipped safeguards.

- **FN-4774** — Added the `fn_task_search` triage tool over `store.searchTasks(...)` (FTS5) with historical coverage defaults (`includeArchived: true`, done tasks included by default) and updated duplicate-check prompt guidance in `packages/engine/src/triage.ts`.
- **FN-4815** — Added regression coverage in `packages/engine/src/__tests__/triage-duplicate-search-regression.test.ts` for the tool contract, duplicate-check prompt guidance, and end-to-end duplicate discovery before task creation.
- **FN-4829** — Added create-time duplicate gating (`POST /tasks/duplicate-check`, `acknowledgedDuplicates` / `bypassDuplicateCheck` on `POST /tasks`, `DuplicateWarningModal`, and `task:duplicate-warning-overridden` activity event).

FN-4866 acceptance-criteria mapping: root-cause analysis ✓ (see **Root cause** above); safeguard recommendation with linked implementation tasks ✓ (FN-4774 and FN-4829); regression test plan ✓ (FN-4815, plus explicit named-case coverage added under this closure task).
