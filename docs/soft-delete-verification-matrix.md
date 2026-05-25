# Soft-delete verification matrix

**Purpose:** Single source of truth for closing the FN-5105 / FN-5135 / FN-5137 / FN-5139 / FN-5140 / FN-5141 / FN-5142 / FN-5143 soft-delete stream.

**Success metric:** 0 reproducible cases where a soft-deleted task is runnable in scheduler / executor / merger / triage or visible in active dashboard queues after refresh or engine tick.

**Gate rule:** Every matrix row is GREEN or has a linked follow-up FN task before the stream is closed.

## Scenario matrix

| Scenario | Pre-state | API (REST) | Scheduler / Executor | Merger | Triage | Dashboard (SSE + initial load) | Agent logs | Documents | Owning FN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Soft-delete a `triage` task with no `PROMPT.md` yet | Live `triage` row; task dir may exist without spec | `DELETE /api/tasks/:id` soft-deletes; later live readers 404 / omit; forensic store access still sees `deletedAt` row | Not dispatchable; auto-claim snapshots exclude it; executor entry points refuse if manually targeted | N/A | Active/queued triage must not re-open it after refresh; active abort is **blocked by FN-5142** | SSE `task:deleted` removes it; reload keeps it absent from board/ListView/TodoView | Preserved until FN-5143 lands | No documents expected; document APIs still treat parent as absent once FN-5140 lands | FN-5105 / FN-5135 / FN-5137 / FN-5142 |
| 2. Soft-delete a `todo` task with dependencies pointing AT it | Live `todo`; other live tasks depend on it | Delete is 409 `TASK_HAS_DEPENDENTS` unless caller opts into `removeDependencyReferences`; retry succeeds and returns soft-deleted task | Deleted task is never redispatched; rewritten dependents clear blocker residue (`dependencies`, `blockedBy`, `status`) and keep running as live tasks | N/A | N/A | SSE removes deleted card; dependents reflect rewritten dependency state on refresh | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5105 / FN-5137 / FN-5566 (re-land FN-5446) |
| 3. Soft-delete a `todo` task with lineage children | Live `todo`; `sourceParentTaskId` children exist | Current contract is 409 with lineage child IDs, then retry with `removeLineageReferences=true`; route/UI wiring is **pending FN-5139** | Deleted parent never dispatches; rewritten children remain live | N/A | N/A | Delete/archive UI must surface confirm-retry flow once FN-5139 lands | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5139 |
| 4. Soft-delete an `in-progress` task with an active executor session | Live `in-progress`; executor owns active session | Delete succeeds; task vanishes from live readers immediately | Entry guards already refuse reruns; active-session abort / dispose is **pending FN-5142** | N/A | N/A | SSE removes card; reload does not re-seed it into active queues | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5137 / FN-5142 |
| 5. Soft-delete an `in-progress` task with an active workflow-step session and reviewer subagent | Live `in-progress`; workflow step child session exists | Delete succeeds; no public recovery/undelete flag | New execution attempts refuse; workflow-step + reviewer abort/cleanup is **pending FN-5142** | N/A | N/A | SSE removes card; reload stays clean | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5142 |
| 6. Soft-delete an `in-review` task that is currently being merged | Live `in-review`; active merge session in flight | Delete succeeds; live readers omit afterward | Scheduler must not requeue it | Active merge abort, queue removal, and controller cleanup are **pending FN-5142** | N/A | SSE removes card; reload keeps it absent | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5142 |
| 7. Soft-delete an `in-review` task queued for merge but not yet active | Live `in-review`; merge queued only | Delete succeeds; row stays for forensics only | Scheduler/executor must not pick it up again | Merge queue must filter it out; pending FN-5142 covers deterministic abort/filter assertions | N/A | SSE removes card; reload keeps it absent | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5137 / FN-5142 |
| 8. Soft-delete a `done` task with archived/visible agent logs and saved task documents | Live `done`; has task docs + agent logs | Delete succeeds; live task readers omit afterward; forensic reads still allowed internally | Not runnable after any engine tick or restart | N/A | N/A | SSE removes card; refresh does not show it in board/ListView/TodoView | `agentLogEntries` must clear atomically; **pending FN-5143** | `/api/documents` and per-task docs must disappear while DB rows remain; **pending FN-5140** | FN-5140 / FN-5143 |
| 9. Soft-delete an archived task | Task already archived / moved out of live `tasks` table | Current contract is not pinned; matrix gate requires deterministic error-or-no-op behavior. Follow-up filed as **FN-5196**. | Must never affect active queues either way | N/A | N/A | No dashboard resurrection; exact UX blocked by FN-5196 | N/A | N/A | FN-5196 |
| 10. Soft-delete a task that is checked out by an agent (`checkedOutBy` set) | Live task with lease / checkout metadata | Delete succeeds; linked agent task references clear with delete | Soft-deleted checked-out task must not be auto-claimed or executed after refresh/tick; extra deterministic coverage filed as **FN-5195** | If merge-owned, FN-5142 owns active merge abort details | If triage-owned, FN-5142 owns active triage abort details | SSE removes card; refresh must not show stale checked-out task | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5137 / FN-5195 |
| 11. Retry-exhausted `in-review` blocker is soft-deleted (`mergeRetries >= 3`) | Row remains in `tasks` with `deletedAt` set; downstream live tasks may still reference blocker in `dependencies`/`blockedBy` | Default task readers still hide it; opt-in surfaces expose it (`GET /api/tasks/exhausted-in-review?includeDeleted=true`, `GET /api/tasks/:id?includeDeleted=true`, `fn_task_show` fallback, `fn_task_list includeDeleted`) | Deadlock/stuck-merge/in-review-stall scans must exclude soft-deleted rows via `listTasks` (`ACTIVE_TASKS_WHERE`), plus per-sweep `task.deletedAt` guards as belt-and-suspenders | No merge-state mutation; blocker remains terminal unless explicit operator action | N/A | ReliabilityView panel explicitly lists hidden exhausted blockers + blocked dependents; main board stays unchanged | Existing logs preserved | Documents readable via opt-in task-detail fetch; no automatic restore | FN-5513 / FN-5528 |

## ID reservation invariant

| Scenario set | Invariant | Evidence owner |
| --- | --- | --- |
| 1-10 | Soft-delete never frees the task ID. The `tasks` row persists with `deletedAt` set and allocators continue scanning all rows, so the ID is not reusable. | FN-5105 / FN-5128 |
| Re-delete of an already soft-deleted task | Second delete is a no-op: same `deletedAt`, no fresh event, ID still reserved. | FN-5127 / FN-5128 |

## Coverage gaps

| Scenario # | Layer | Existing coverage (file:line) | Gap | Proposed test file target | Owning FN |
| --- | --- | --- | --- | --- | --- |
| 1,4,7,10 | Scheduler invalidation on `task:deleted` | `packages/engine/src/__tests__/scheduler-auto-claim-invalidation.test.ts:31` | GREEN | — | FN-5137 |
| 1,4,7,10 | Executor `execute()` refusal of soft-deleted task | `packages/engine/src/__tests__/executor-soft-delete-guard.test.ts:50` | GREEN | — | FN-5137 |
| 4,5 | In-flight executor / workflow-step / reviewer abort on `task:deleted` | Entry-guard coverage only; no active-session abort assertion | Missing deterministic abort + dispose assertions | `packages/engine/src/__tests__/executor-soft-delete-abort.test.ts` and `packages/engine/src/__tests__/reliability-interactions/soft-delete-in-flight-abort.test.ts` | FN-5142 |
| 6,7 | In-flight merge abort / merge queue filtering | No deterministic merge-abort assertion in current corpus | Missing active merge abort + queued merge filtering coverage | `packages/engine/src/__tests__/project-engine-soft-delete-merge-abort.test.ts` | FN-5142 |
| 1,10 | Triage abort on `task:deleted` | No deterministic triage abort assertion in current corpus | Missing active triage session + subagent abort coverage | `packages/engine/src/__tests__/triage-soft-delete-abort.test.ts` | FN-5142 |
| 11 | Deadlock/stuck-merge/in-review-stall scan exclusion for soft-deleted exhausted blockers | Added in this task | GREEN — defensive sweep guards + script `WHERE deletedAt IS NULL` backstop | `packages/engine/src/__tests__/reliability-interactions/soft-delete-deadlock-scan-exclusion.test.ts`, `scripts/__tests__/recover-stale-blocked-by.test.mjs` | FN-5528 |
| 2,11 | Soft-delete blocker residue + legacy column drift reconciliation (`deletedAt` + non-archived column) | Added in this task | GREEN — in-transaction blocker cleanup, periodic/startup column-drift reconciler, and audit mutation `task:soft-delete-column-reconciled` | `packages/engine/src/__tests__/reliability-interactions/soft-delete-blocker-residue.test.ts`, `packages/core/src/__tests__/store-delete-task-blocker-residue.test.ts` | FN-5566 (re-land FN-5446) |
| 8 | `agentLogEntries` cleared on soft-delete | No dedicated coverage today | Missing atomic clear + post-delete empty-reader assertion | `packages/core/src/__tests__/soft-delete-agent-logs.test.ts` | FN-5143 |
| 8 | `/api/documents` and per-task docs exclude soft-deleted parents | No dedicated soft-delete document visibility assertion today | Missing store + route coverage | `packages/core/src/__tests__/task-documents.test.ts` and `packages/dashboard/src/__tests__/routes-tasks.test.ts` | FN-5140 |
| 3 | Lineage-unlink 409 flow through API + UI | Store lineage guards are covered; route/UI flow is not | Missing 409 payload + confirm-retry UX coverage | `packages/dashboard/src/__tests__/routes-tasks-ops.test.ts`, `packages/dashboard/app/utils/__tests__/taskDelete.test.ts`, `packages/dashboard/app/components/__tests__/TaskCard.test.tsx`, `packages/dashboard/app/components/__tests__/TaskDetailModal.responsive-and-dependencies.test.tsx`, `packages/dashboard/app/components/__tests__/ListView.test.tsx` | FN-5139 |
| Stream-wide | `fn_task_delete` tool / skill terminology | No regression asserting soft-delete wording | Missing user-facing copy coverage | `packages/cli/src/__tests__/extension.test.ts` | FN-5141 |
| 1,4,6,7,8 | Dashboard SSE + reload deleted-task filtering | `packages/dashboard/src/__tests__/sse-task-deleted-payload.test.ts:5`; `packages/dashboard/app/hooks/__tests__/useTasks.test.ts:1124`; `packages/dashboard/app/hooks/__tests__/useTasks.test.ts:1147`; `packages/dashboard/app/hooks/__tests__/useTasks.test.ts:1255` | GREEN | — | FN-5135 |
| 4,10 | Cross-layer delete-during-execution / refresh convergence | No single composition backstop before this task | Added in this task | `packages/engine/src/__tests__/reliability-interactions/soft-delete-end-to-end.test.ts` | FN-5153 |
| 9 | Archived-task delete contract | No deterministic store/route assertion; behavior not pinned | New follow-up filed | `packages/core/src/__tests__/soft-delete-tasks.test.ts` and `packages/dashboard/src/__tests__/routes-tasks.test.ts` | FN-5196 |
| 10 | Checked-out-task soft-delete composition | Entry guards exist, but no coverage focused on checked-out deleted tasks | New follow-up filed | `packages/core/src/__tests__/soft-delete-tasks.test.ts` and `packages/engine/src/__tests__/auto-claim-snapshot-soft-delete.test.ts` | FN-5195 |

## Release-blocking checks

- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm --filter @fusion/dashboard test:browser-smoke`
- Every scenario-matrix row is GREEN or has a linked follow-up FN task before the FN closing that row merges
- `packages/engine/src/__tests__/reliability-interactions/soft-delete-end-to-end.test.ts` is fully un-skipped before the stream is declared closed
- Manual smoke once on the live dashboard at port 4040: delete one `todo`, one `in-progress`, and one `in-review` task; refresh; confirm none reappear in any board column, ListView, or TodoView; confirm no SSE flicker re-adds the card
- `node scripts/audit-squash-merge.mjs <sha>` remains unaffected by any task in this stream

## Forensic access escape hatch

Supported forensic access is internal only:

- `readTaskFromDb(id, { includeDeleted: true })` in `packages/core/src/store.ts`
- direct SQL against `tasks`, `task_documents`, and `agentLogEntries`

No public API flag exposes deleted-task forensics today. Adding one requires a new FN with its own review.

## Out of scope

- Undelete UX / restore-from-trash flow — file a new FN if requested
- Hard-delete UI — file a new FN if requested
- Mission / feature / slice soft-delete — those entities do not use `deletedAt` today; file a new FN if requested
- Agent / node / secret soft-delete — file a new FN if requested

## Notes

- FN-5496: `task:deleted` now triggers immediate scheduler-side downstream `blockedBy` reconciliation for `todo`/`in-progress` dependents, and stale-blockedBy self-healing logs now discriminate soft-deleted blockers with `soft-deleted at ...` reasons.
- Store-level soft-delete invariants live in `packages/core/src/store.ts` (`ACTIVE_TASKS_WHERE`, `deleteTask`, `readTaskFromDb(..., { includeDeleted: true })`) and `packages/core/src/__tests__/soft-delete-tasks.test.ts`.
- Cross-reference `docs/storage.md` for the persisted-row model; FN-5140 and FN-5143 own the storage-doc deltas for document and agent-log visibility.