---
title: Workflow Runtime Cutover Hardening
type: fix
date: 2026-06-23
source_plan: docs/plans/2026-06-23-001-fix-workflow-runtime-cutover-plan.md
---

# Workflow Runtime Cutover Hardening

## Summary

Make workflow columns and graph execution safe as the default runtime by hardening the scheduler hold/release path, preserving executor recovery semantics, graduating stale workflow flags out of Experimental settings, and removing dead legacy dispatch only after reachability and rollback safety are proven.

---

## Problem Frame

The initial workflow runtime cutover made the workflow paths default, but review found the new path was not yet equivalent to legacy scheduler and executor invariants. The highest-risk gaps are capacity handling in the hold/release scheduler path, graph failure handling that can overwrite inner executor recovery, missing replacement tests after legacy test deletion, and incomplete flag graduation. This plan supersedes the earlier cutover plan with the document-review findings folded into executable scope.

---

## Requirements

**Branch and rollback**

- R1. Keep unrelated dashboard/cosmetic changes out of the workflow cutover PR.
- R2. Preserve rollback safety by keeping the cutover on an isolated branch and staging irreversible legacy-dispatch deletion behind reachability tests and validation evidence.
- R3. Users upgrading from a prior version must not have tasks stall because of stale workflow flag values, legacy columns, existing `todo`/`in-progress`/`in-review` rows, or persisted worktree/lease state.
- R4. The first published cutover release must have a verified operator rollback or downgrade path, including support guidance for users whose eligible tasks stop progressing after upgrade.

**Scheduler runtime**

- R5. The workflow hold/release scheduler path must preserve dispatch gates for dependencies, blocked missions, filesystem/spec staleness, pause states, checkout leases, node routing, permanent-agent availability, file-scope overlap, dispatch oscillation, `maxWorktrees`, `maxConcurrent`, and shared semaphore pressure.
- R6. Capacity failure must leave tasks queued and must not log `Starting`, clear status, or call `onSchedule` before all reservation checks pass.
- R7. Scheduler handoff failures after hold creation, release, `onSchedule`, or executor invocation must leave tasks recoverable and must not leak stale holds.

**Executor runtime**

- R8. `TaskExecutor.execute()` must use graph-default behavior even when stale persisted `workflowGraphExecutor=false` exists.
- R9. Graph-default execution must preserve legacy recovery semantics: inner executor requeues, mismatched store-row protection, pause aborts, duplicate execute protection, worktree liveness recovery, and no-`fn_task_done` handling.

**Flag graduation**

- R10. Workflow columns and workflow graph executor must no longer appear as user-facing Experimental kill switches.
- R11. Stale persisted workflow flag values must be ignored by runtime helpers and must not route old installations back to legacy behavior.
- R12. Hidden graduated workflow keys must have deterministic Settings save behavior when users save unrelated settings after upgrade.
- R13. Stale persisted `workflowInterpreterDualObserve=true` must either be ignored after graduation or remain controllable through a non-user operator mechanism; it must not stay enabled invisibly with no way to disable it.

**Test and review gate**

- R14. Every test referenced by `packages/engine/vitest.config.ts` must be tracked and committed.
- R15. Deleted legacy scheduler/executor tests must be replaced by targeted workflow-path coverage for the same live invariants before the PR removes the old files.
- R16. The branch must pass targeted engine/core tests, lint, typecheck, root test, build, and a follow-up `compound-engineering:ce-code-review`.

---

## Key Technical Decisions

- KTD1. Scheduler reservations stay non-mutating until all gates pass. The hold/release callback can inspect `maxConcurrent`, `maxWorktrees`, and `AgentSemaphore.availableCount`, but executor still owns the actual semaphore acquire so the scheduler does not double-acquire a slot.
- KTD2. Capacity tests must include race-shaped cases. Single-gate tests are not enough; coverage must prove same-sweep held-task releases under `maxConcurrent=1`, `maxWorktrees=1`, and saturated semaphore conditions.
- KTD3. Graph failure handling must treat the originally dispatched task ID as authoritative. If a minimal or stale store returns a different row from `getTask(task.id)`, graph recovery must preserve the inner executor result instead of mutating the wrong task.
- KTD4. Legacy dispatcher removal is last. The PR may harden graph-default and hold/release first; deleting unreachable legacy scheduler code happens only after stale-flag reachability and replacement tests prove no live entrypoint still depends on it.
- KTD5. Published rollback must be operational, not only source-control based. Before legacy deletion ships, the plan must prove either an operator-only fallback can restore scheduling without re-exposing Experimental user switches, or a documented downgrade/revert path works against cutover-era settings and task rows.
- KTD6. Flag graduation is a runtime and UI change. Defaults, helper semantics, Settings UI, and Settings save payloads must agree: stale persisted values are tolerated, but users cannot toggle these default runtime paths off from Experimental settings.
- KTD7. Upgrade safety is proved at persisted-state boundaries. Tests should use frozen prior-version fixtures or generate state with the previous released storage code, then exercise the real scheduler/executor entrypoints so task progression is verified after upgrade rather than inferred from helper behavior.

---

## Implementation Units

### U1. Branch Isolation And Diff Hygiene

- **Goal:** Keep the PR rollback boundary clean and exclude unrelated cosmetic work.
- **Files:** `docs/plans/2026-06-23-002-workflow-runtime-cutover-hardening-plan.md`
- **Approach:** Base the PR branch on `origin/main`, carry only workflow runtime, flag graduation, test, plan, and release metadata changes, and verify the diff does not include unrelated dashboard cosmetic files.
- **Test scenarios:** `git diff --name-only origin/main...HEAD` excludes cosmetic files such as `packages/dashboard/app/components/ScriptsModal.css` and `packages/dashboard/app/components/__tests__/ScheduledTasksModal.test.tsx`.
- **Verification:** Inspect branch history and PR file list before opening the PR.

### U2. Scheduler Hold/Release Dispatch Equivalence

- **Goal:** Make the workflow hold/release scheduler path equivalent to legacy live dispatch gates.
- **Files:** `packages/engine/src/scheduler.ts`, `packages/engine/src/hold-release.ts`, `packages/engine/src/__tests__/scheduler-workflow-cutover.test.ts`, `packages/engine/vitest.config.ts`
- **Approach:** Move or share all live pre-dispatch checks into the hold/release reservation path. Run dependency, mission, filesystem/spec, pause, lease, node, permanent-agent, overlap, oscillation, and capacity checks before any status-clearing update or `Starting` log. Preserve `onSchedule` as a post-release effect only.
- **Test scenarios:** Cover dependency blocking, blocked mission, filesystem invalidation, stale prompt, global/engine/user pause, stale lease recovery failure, node validation block/fallback/handoff, no permanent executor, overlap lease, oscillation auto-pause, `maxConcurrent=1`, `maxWorktrees=1`, saturated semaphore, same-sweep multi-task race, prior-version stale workflow settings, pre-existing `todo` tasks, successful post-release `onSchedule`, and injected failures after hold creation, after release before executor invocation, after `onSchedule`, and after executor invocation throws before semaphore acquisition.
- **Verification:** `pnpm --filter @fusion/engine exec vitest run src/__tests__/scheduler-workflow-cutover.test.ts`

### U3. Executor Graph Entry And Recovery Equivalence

- **Goal:** Prove the production `TaskExecutor.execute()` entrypoint preserves legacy recovery behavior under graph-default execution.
- **Files:** `packages/engine/src/executor.ts`, `packages/engine/src/__tests__/workflow-graph-task-runner.test.ts`, `packages/engine/src/__tests__/executor-worktree.test.ts`, `packages/engine/src/__tests__/restart.integration.test.ts`, tests under `packages/engine/src/__tests__/reliability-interactions/`
- **Approach:** Keep the original dispatched task identity through graph runner setup and graph failure handling. Preserve inner executor recovery when the execute node requeues to `todo`. Ensure `prepareWorktree` returns an existing task worktree or an empty string, never the repo root.
- **Test scenarios:** Cover stale `workflowGraphExecutor=false`, unmet dependency pre-graph requeue, satisfied dependency graph dispatch, mismatched live row before runner start, mismatched live row in failure handling, inner executor `todo` requeue preservation, duplicate execute locking, pause/user-pause/global-pause abort behavior, worktree liveness requeue, and no-`fn_task_done` recovery final column parity.
- **Verification:** `pnpm --filter @fusion/engine exec vitest run src/__tests__/workflow-graph-task-runner.test.ts src/__tests__/executor-worktree.test.ts src/__tests__/restart.integration.test.ts src/__tests__/reliability-interactions/executor-liveness-gate.test.ts src/__tests__/reliability-interactions/executor-no-task-done-vs-worktree-reclaim.test.ts`

### U4. Workflow Flag Graduation

- **Goal:** Remove user-facing workflow kill switches while preserving stale persisted value compatibility.
- **Files:** `packages/core/src/workflow-columns-settings.ts`, `packages/core/src/experimental-features.ts`, `packages/core/src/settings-schema.ts`, `packages/core/src/__tests__/settings-defaults.test.ts`, `packages/core/src/__tests__/workflow-cutover.test.ts`, `packages/dashboard/app/components/settings/sections/ExperimentalSection.tsx`, `packages/dashboard/app/components/__tests__/WorkflowNodeEditor.test.tsx`, `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx`, `packages/dashboard/app/__tests__/settings-sections.test.tsx`
- **Approach:** Keep runtime helpers always enabling workflow columns and graph execution regardless of stale false persisted values. Remove graduated workflow flags from defaults and from Experimental settings UI. Decide and test the Settings save-payload behavior for hidden graduated keys. Keep dual-observe off by default and hidden only if stale true values are ignored or an operator-only control remains.
- **Test scenarios:** Core settings defaults omit `workflowColumns` and `workflowGraphExecutor`; stale false values still produce enabled runtime helpers; upgraded prior-version settings retain harmless unknown experimental entries without disabling workflow runtime; Settings UI does not render workflow columns, workflow graph executor, or dual-observe controls in Experimental settings; opening Settings with stale hidden workflow keys, changing an unrelated Experimental toggle, and saving follows the documented payload behavior for those hidden keys; stale `workflowInterpreterDualObserve=true` is ignored or remains controllable through an operator-only mechanism.
- **Verification:** `pnpm --filter @fusion/core exec vitest run src/__tests__/settings-defaults.test.ts src/__tests__/workflow-cutover.test.ts` plus targeted dashboard settings tests.

### U5. Upgrade Progression Coverage

- **Goal:** Prove existing users' task queues keep progressing after upgrading into the cutover.
- **Files:** `packages/core/src/__tests__/workflow-cutover.test.ts`, `packages/engine/src/__tests__/scheduler-workflow-cutover.test.ts`, targeted executor/reliability tests under `packages/engine/src/__tests__/`
- **Approach:** Seed representative prior-version persisted state from frozen fixtures for the previous released version or by generating fixtures with that version's storage code. Include stale experimental flags, legacy/custom workflow columns where applicable, existing `todo` rows, existing `in-progress` rows with worktrees, existing `in-review` rows, paused/user-paused rows, and checked-out rows with lease metadata. Run real scheduler/executor entrypoints and assert dispatchable tasks continue while intentionally paused/blocked tasks remain parked for the correct reason.
- **Test scenarios:** Upgraded `todo` tasks dispatch through hold/release; upgraded `in-progress` tasks are not duplicated or stolen; upgraded `in-review` tasks continue review/merge handling; paused/user-paused tasks do not auto-resume; stale leases follow existing recovery policy; stale workflow flags do not prevent any eligible task from progressing.
- **Verification:** Include these scenarios in `scheduler-workflow-cutover.test.ts`, `workflow-cutover.test.ts`, or focused reliability tests before deleting legacy dispatcher coverage.

### U6. Release Rollback Proof

- **Goal:** Prove users have a usable post-release recovery path if the cutover stalls eligible task progression.
- **Files:** `docs/plans/2026-06-23-002-workflow-runtime-cutover-hardening-plan.md`, `.changeset/workflow-runtime-cutover.md`, and rollback/downgrade tests or scripts if added
- **Approach:** Before legacy deletion ships, prove one rollback path: an operator-only runtime fallback that restores scheduling without re-exposing user-facing Experimental controls, or a documented downgrade/revert procedure that works against cutover-era settings and task rows. The support guidance should tell users how to identify intentionally parked tasks versus eligible tasks that should progress.
- **Test scenarios:** Seed cutover-era settings and task rows, run the chosen rollback/downgrade procedure, and assert eligible tasks resume scheduling while paused/dependency-blocked tasks remain correctly parked.
- **Verification:** Rollback proof is documented in the patch changeset Upgrade Notes or a linked support note before the PR is opened.

### U7. Legacy Dispatch Deletion And Reachability Proof

- **Goal:** Remove the unreachable legacy scheduler dispatcher without deleting a path that stale settings can still reach.
- **Files:** `packages/engine/src/scheduler.ts`, `packages/engine/src/__tests__/scheduler-workflow-cutover.test.ts`, `packages/engine/vitest.config.ts`
- **Approach:** After U2 through U6 pass, delete or collapse the legacy todo dispatcher code that sits after the workflow sweep return. Preserve reporter emission and non-dispatch scheduler duties. Broaden reachability assertions beyond stale `workflowColumns=false`: prove stale graph false, legacy/custom columns, existing `todo`/`in-progress`/`in-review` rows, reporter-only scheduler duties, exported scheduler helpers, and plugin-facing entrypoints either enter hold/release or are explicitly removed with replacement tests. U5 upgrade-progression and U6 rollback proof are prerequisites for deleting legacy dispatcher code or removing legacy coverage.
- **Test scenarios:** Stale persisted `workflowColumns=false` still schedules through hold/release; stale graph false does not route to legacy execution; legacy/custom columns and existing task rows keep progressing or remain intentionally parked; no test, production, exported helper, or plugin-facing callsite references removed dispatcher helpers; engine-core gate includes tracked replacement workflow tests.
- **Verification:** `pnpm --filter @fusion/engine typecheck`, `pnpm --filter @fusion/engine test:core`, and `rg` checks for removed helper names if helpers are deleted.

### U8. Validation, Review, And PR

- **Goal:** Finish the branch with objective verification and a reviewable PR.
- **Files:** `packages/engine/vitest.config.ts`, `.changeset/workflow-runtime-cutover.md`
- **Approach:** Run targeted tests first, then root checks. Add a patch changeset for `@runfusion/fusion` because this default-runtime cutover affects published behavior. The changeset must include Upgrade Notes covering workflow columns and graph execution becoming default, stale workflow flag values being ignored, removed Experimental controls, expected behavior for eligible versus intentionally parked tasks, and the verified rollback/support path. Run code review after tests are green and fix actionable findings before PR.
- **Test scenarios:** Targeted tests prove the invariant matrix; root commands prove workspace integration.
- **Verification:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `compound-engineering:ce-code-review mode:agent plan:docs/plans/2026-06-23-002-workflow-runtime-cutover-hardening-plan.md`.

---

## Acceptance Examples

- AE1. Given a ready `todo` task and `maxConcurrent=1` with another task already in progress, when the scheduler sweep runs, then the ready task remains queued, no `Starting` log is written, and `onSchedule` is not called.
- AE2. Given a saturated shared semaphore held by non-task work, when the scheduler sweep evaluates a ready `todo` task, then the task is not moved to `in-progress` and the queued reason names semaphore or concurrency pressure.
- AE3. Given stale persisted `workflowGraphExecutor=false`, when `TaskExecutor.execute()` runs a task with satisfied dependencies, then graph-default execution still runs and the legacy fallback path is not used.
- AE4. Given graph execute delegates to the inner executor and the inner executor requeues the task to `todo`, when the outer graph run reports execute failure, then the task remains available for normal scheduling and is not parked as failed or in review.
- AE5. Given stale persisted `workflowColumns=false`, when scheduler `schedule()` runs, then hold/release scheduling is used and the deleted legacy dispatcher is unreachable.
- AE6. Given Experimental settings render, when the workflow cutover is complete, then workflow columns, workflow graph executor, and dual-observe controls are absent.
- AE7. Given a user upgrades with existing `todo`, `in-progress`, and `in-review` tasks, when the scheduler and executor start after upgrade, then eligible tasks keep progressing and intentionally paused or dependency-blocked tasks remain parked with the correct reason.
- AE8. Given a user upgrades with stale workflow experimental settings, when tasks are scheduled or executed, then those stale settings are tolerated and do not disable workflow columns or graph execution.
- AE9. Given a user opens Settings after upgrade with stale hidden workflow keys, when they save an unrelated settings change, then the hidden workflow keys follow the documented payload behavior and cannot silently re-disable the default runtime.
- AE10. Given a published cutover release stalls eligible task progression, when an operator follows the documented rollback or downgrade path, then eligible tasks resume without corrupting persisted settings or task rows.

---

## Scope Boundaries

- In scope: scheduler hold/release equivalence, executor graph-default recovery equivalence, workflow flag graduation, replacement tests, legacy dispatcher removal once proven unreachable, and PR validation.
- In scope: upgrade-state tests for prior-version settings and existing task rows needed to prove tasks keep progressing.
- Out of scope: unrelated dashboard cosmetic fixes, new workflow editor UI behavior, new workflow engine features, and broad scheduler rewrites not required to preserve existing invariants.
- Deferred unless U6 proves branch/downgrade rollback is insufficient: a permanent operational feature flag. User-facing Experimental kill switches remain out of scope.

---

## System-Wide Impact

This change touches the task execution lifecycle, scheduler admission control, settings defaults, Settings UI, and the engine merge gate. Failures can block task execution across projects, so test coverage must prove behavior at the production entrypoints rather than only at helper seams.

---

## Risks And Dependencies

- Capacity handling can fail in two opposite ways: bypassing capacity entirely or double-acquiring a semaphore slot before executor runs. U2 must avoid both.
- Reservation handoff can leak if an exception lands between hold creation and executor ownership. U2 must inject these failures and prove later sweeps recover.
- Legacy test deletion can hide active invariants unless replacement tests are tracked and committed in the same PR.
- Removing user-facing flags before stale persisted values are ignored can strand existing installations on removed code paths.
- Hiding dual-observe without clearing or controlling stale true values can leave diagnostic behavior running invisibly.
- Deleting legacy dispatcher code without reachability proof makes rollback more expensive than branch revert alone.

---

## Verification

- `git diff --name-only origin/main...HEAD`
- `pnpm --filter @fusion/engine exec vitest run src/__tests__/scheduler-workflow-cutover.test.ts`
- `pnpm --filter @fusion/engine exec vitest run src/__tests__/workflow-graph-task-runner.test.ts src/__tests__/executor-worktree.test.ts src/__tests__/restart.integration.test.ts src/__tests__/reliability-interactions/executor-liveness-gate.test.ts src/__tests__/reliability-interactions/executor-no-task-done-vs-worktree-reclaim.test.ts`
- `pnpm --filter @fusion/core exec vitest run src/__tests__/settings-defaults.test.ts src/__tests__/workflow-cutover.test.ts`
- Targeted dashboard settings tests for Experimental settings visibility
- `pnpm lint`
- `pnpm typecheck`
- `pnpm smoke:boot`
- `pnpm test:gate`
- `pnpm test`
- `pnpm build`
- `compound-engineering:ce-code-review mode:agent plan:docs/plans/2026-06-23-002-workflow-runtime-cutover-hardening-plan.md`
