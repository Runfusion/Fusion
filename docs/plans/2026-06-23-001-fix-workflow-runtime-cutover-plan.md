---
title: Fix Workflow Runtime Cutover
date: 2026-06-23
status: planned
---

# Fix Workflow Runtime Cutover

## Problem

The workflow graph and workflow-column runtime paths are being made default, but the first cutover review found that the new dispatch path is not yet equivalent to the legacy scheduler/executor invariants. The work must move the cutover onto an isolated branch and make the new path safe before opening a PR.

## Requirements

- R1: Keep unrelated dashboard/cosmetic changes out of the workflow cutover branch.
- R2: The workflow hold/release scheduler path must preserve dispatch safety: dependency, mission, filesystem/spec, pause, lease, node-routing, permanent-agent, overlap, oscillation, `maxWorktrees`, `maxConcurrent`, and semaphore behavior.
- R3: `TaskExecutor.execute()` must prove the graph-default entrypoint preserves legacy recovery behavior, including inner executor requeues and mismatched store-row protection.
- R4: The gate must be self-contained: every test referenced by `packages/engine/vitest.config.ts` must be tracked and committed.
- R5: Legacy workflow flags should not remain user-facing experimental kill switches, but stale persisted values must be tolerated.
- R6: Remove or neutralize unreachable legacy scheduler dispatch code so future fixes do not land in dead paths.
- R7: Validate with lint, typecheck, build, gate, and targeted engine tests before PR.

## Implementation Units

### U1. Isolate Branch State

Files:
- `packages/dashboard/app/components/ScriptsModal.css`
- `packages/dashboard/app/components/__tests__/ScheduledTasksModal.test.tsx`
- `docs/plans/2026-06-23-001-fix-workflow-runtime-cutover-plan.md`

Approach:
- Commit the dashboard/cosmetic automations spacing changes on `main`.
- Preserve workflow cutover work on a dedicated branch for review and rollback.
- Ensure `main` is not left carrying uncommitted workflow cutover edits.

Tests:
- `pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/ScheduledTasksModal.test.tsx`

### U2. Scheduler Dispatch Equivalence

Files:
- `packages/engine/src/scheduler.ts`
- `packages/engine/src/hold-release.ts`
- `packages/engine/src/__tests__/scheduler-workflow-cutover.test.ts`
- `packages/engine/vitest.config.ts`

Approach:
- Move all live pre-dispatch gates into the workflow hold/release reservation path or a shared helper used by that path.
- Fix capacity ordering so no task is marked starting or status-cleared until all reservation checks pass.
- Preserve `maxConcurrent` and shared semaphore semantics without double-acquiring the executor semaphore.
- Make the replacement gate test tracked and broad enough to cover the migrated invariants.

Tests:
- `pnpm --filter @fusion/engine exec vitest run src/__tests__/scheduler-workflow-cutover.test.ts`
- `pnpm --filter @fusion/engine test:core`

### U3. Executor Graph Entry And Recovery

Files:
- `packages/engine/src/executor.ts`
- `packages/engine/src/__tests__/workflow-graph-task-runner.test.ts`
- Targeted executor tests under `packages/engine/src/__tests__/`

Approach:
- Ensure graph execution preserves the original dispatched task identity.
- Fix graph failure handling so inner executor self-heal/requeue is not overwritten by outer graph parking.
- Ensure graph `prepareWorktree` does not pre-acquire or pass the repo root as a task worktree.
- Restore direct `TaskExecutor.execute()` coverage for default-on graph behavior and recovery semantics.

Tests:
- Focused executor recovery/worktree/liveness tests affected by graph-default behavior.
- `pnpm --filter @fusion/engine test:core`

### U4. Remove Dead Legacy Dispatch Surface

Files:
- `packages/engine/src/scheduler.ts`
- `packages/engine/vitest.config.ts`

Approach:
- After U2 coverage is in place, remove unreachable legacy todo dispatcher code or reduce it to any still-needed shared helpers.
- Keep reporter emission and non-dispatch scheduler duties intact.

Tests:
- `pnpm --filter @fusion/engine typecheck`
- `pnpm --filter @fusion/engine test:core`

## Verification

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `compound-engineering:ce-code-review mode:agent plan:docs/plans/2026-06-23-001-fix-workflow-runtime-cutover-plan.md`

## Risks

- The workflow path is central engine infrastructure; green gate alone is not enough if broad affected tests still show executor/scheduler invariant regressions.
- Semaphore handling must avoid both failure modes found in review: bypassing capacity entirely and double-acquiring before the executor can run.
