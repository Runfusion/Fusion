---
category: architecture-patterns
module: core/task-store
tags: [workflow-ir, postgres, sync-readers, custom-fields, silent-defaults]
problem_type: silent-wrong-answer
applies_when: reading a task's workflow synchronously, or converting a column literal to a trait lookup
---

# Every sync workflow-IR read answers for the DEFAULT workflow

Found 2026-07-29 while clearing a review thread on PR #2593, which reported the problem as
PostgreSQL-specific. It is not PG-specific — it is unconditional.

## The chain (verified by reading, each link checkable)

1. `TaskStore.getTaskWorkflowSelection(taskId)` delegates straight to
   `getTaskWorkflowSelectionImpl` with no mode branch (`store.ts`).
2. `getTaskWorkflowSelectionImpl` **returns `undefined` unconditionally**
   (`workflow-definitions.ts`). Its own comment: "sync selection reader is incomplete-PG; use
   `getTaskWorkflowSelectionAsync`." It was left as a stub during the PG cutover.
3. `resolveTaskWorkflowIrSyncImpl` therefore always takes its `if (!workflowId)` branch and returns
   `resolveDefaultWorkflowIr()`. Its `isBuiltinWorkflowId` and `SELECT ir FROM workflows` branches
   are unreachable in production.

So `resolveTaskWorkflowIrSync` returns the default coding IR for every task, always. It is typed
`WorkflowIr` (non-optional), so callers cannot detect the substitution: there is no `undefined` to
check, and the IR that arrives looks perfectly valid.

## Why tests do not catch it

Test stores stub `getTaskWorkflowSelection` to return a real selection, so the sync reader resolves
correctly under test and returns the default only in production. Any test written against a stubbed
store proves the caller's logic, never the reader's substitution.

## Consequences found (severity descending)

**1. Custom fields are rejected on custom workflows.** `resolveTaskCustomFieldDefsSyncImpl` returns
`ir.fields`, so it returns the DEFAULT workflow's fields. `task-update.ts` then validates the patch
against them, and its own comment records the outcome: "a write against a workflow with no fields
(the default) is rejected with a typed `CustomFieldRejectionError`". So `updateTask({ customFields })`
on a task whose custom workflow defines fields is rejected as unknown-id. Same reader is used by
`workflow-ops.ts` for the old-defs diff.

REASONED FROM SOURCE, NOT OBSERVED: I did not execute this path. No test in `packages/core` covers
`CustomFieldRejectionError` or `resolveTaskCustomFieldDefsSync`, which is consistent with the gap but
is not proof. Reproduce before fixing.

**2. Per-workflow capacity pools collapse.** `resolveEffectiveWorkflowIdSyncImpl` reads the same
selection, so it always calls `resolveCapacityPoolId(undefined)` — every task resolves to the default
pool regardless of its workflow.

**3. Plugin transition hooks re-run against the wrong IR.** `lifecycle-ops.ts` crash-recovery passes
this IR to `runPluginColumnTransitionHooks`, so a custom-workflow card's hooks are evaluated against
default columns.

**4. Terminal-node detection degrades.** `isTaskTerminalNodeIdImpl` looks up a node id in the default
IR and falls back to `nodeId === "end"`. Mostly harmless, but a custom workflow whose node id
collides with a default non-end node id gets a wrong answer rather than the fallback.

**5. A U7 guard was inert (fixed in #2593).** `recoverApprovedTask`'s orphan-`triage` scoping asked
whether the task's workflow declares `triage`; it was always asking the default. Its fail-closed arm
tested `workflowIr ? … : true`, which is dead code against a non-optional return. Now uses
`resolveWorkflowIrForTaskWithProvenance` and fails closed on `source: "default"`.

## The rule

**Never read a task's workflow synchronously.** Use `resolveWorkflowIrForTaskWithProvenance` and
branch on `source`: `"selection"` is verified by IR identity, so it is the only value that means "this
is really the task's workflow". Treat `"default"` as "unknown" and choose the conservative answer.

This matters for the census conversions specifically: replacing `column === "triage"` with a trait
lookup that resolves through a SYNC reader produces a guard that reads the default workflow's traits
for every task — plausible, wrong, and invisible. It converts a visible literal into a hidden bug.

## Not fixed here

Each consequence needs its sync call path made async, which is a real slice per site. This document
is the finding; the fixes are follow-ups. #2593 fixed only the one that was mine.
