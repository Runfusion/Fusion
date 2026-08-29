---
category: architecture-patterns
module: core/task-store
tags: [workflow-ir, postgres, sync-readers, custom-fields, silent-defaults]
problem_type: silent-wrong-answer
applies_when: reading a task's workflow synchronously, or converting a column literal to a trait lookup
---

# Every sync workflow-IR read answers for the DEFAULT workflow — through the production `TaskStore`

Found 2026-07-29 while clearing a review thread on PR #2593, which reported the problem as
PostgreSQL-specific. It is not PG-specific.

SCOPE, corrected after review: "always" describes the production `TaskStore`, not the
`WorkflowIrResolverStore` INTERFACE. That interface declares
`getTaskWorkflowSelection(taskId): { workflowId; stepIds } | undefined` and a conforming
implementation is free to return a real selection — the test fixtures do exactly that, which is
also why the substitution is invisible under test (see "Why tests do not catch it" below).

The unconditional `undefined` belongs to ONE implementation: `getTaskWorkflowSelectionImpl`, which
the production store delegates to with no mode branch. So the accurate claim is "every sync read
THROUGH THE PRODUCTION STORE answers for the default workflow", and the reason it is worth a
document is that the production store is the only implementation that ships.

Stating it loosely matters here in a specific way: a reader who takes "always" as a property of the
interface would conclude the sync path is unusable and rewrite callers that are fine, while a reader
who takes it as a property of the impl looks in the right place — at a stub left behind by the PG
cutover.

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

Three production callers, not one — verified by grep while checking the review correction below:
`task-update.ts` (update), `workflow-ops.ts` (the old-defs diff on workflow change), and
`workflow-task-create-ops.ts` (task CREATE). So the exposure covers creating a task with custom
fields as well as updating one.

REASONED FROM SOURCE, NOT OBSERVED: I did not execute this path. No test in `packages/core` covers
`CustomFieldRejectionError` or `resolveTaskCustomFieldDefsSync`, which is consistent with the gap but
is not proof. Reproduce before fixing.

METHOD NOTE, earned the hard way: a consequence is only real if something CALLS the defective
function. I listed the capacity item without checking, and review caught it. Every other item here
has had its call sites verified — `isTaskTerminalNodeIdImpl` via the `isTerminalNodeId` callback in
`branch-and-pr-entities.ts`, the hook re-run in `lifecycle-ops.ts`, and the three above.

**2. The synchronous capacity-pool helper returns the default pool — but nothing calls it.**
`resolveEffectiveWorkflowIdSyncImpl` reads the same selection, so it always calls
`resolveCapacityPoolId(undefined)`. CORRECTED after review: I first wrote this as "per-workflow
capacity pools collapse", which was wrong and would have sent someone to fix an unused path. The
binding capacity path reads the selection ASYNCHRONOUSLY inside its transaction, and this sync helper
has NO callers — `grep` finds only its own definition, its `Impl`, and one comment. Latent, not live:
it becomes real the moment someone calls it, which is the only reason it is still listed.

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

**6. ALL planner-lane resolution in the engine is default-workflow-only — the largest one, found last.**
`resolvePlannerLanes` (`replan-target.ts`) resolves `intake`/`hold`/`wip`/`review` by calling
`resolveTaskWorkflowIrSync`, so it derives every lane from the DEFAULT workflow for every task.
10 call sites in `executor.ts` and `triage.ts` depend on it — planning wake/dispose, replan
targeting, and the approved-plan recovery gate.

Consequence: for a workflow whose intake is renamed (say `inbox`), `lanes.intake` resolves to `todo`,
so a card sitting in `inbox` is not recognised as being in its own planner column and the recovery
never fires. That is the same class of bug as the U7 stall this program has been fixing, one layer
down, and it is invisible because the lanes returned are a valid-looking set from the wrong workflow.

THIS IS WHY THE TESTS PASS. On a bare mock store `resolveTaskWorkflowIrSync` is absent, so
`resolvePlannerLanes` returns `LEGACY_PLANNER_LANES` (`intake: "triage"`) and a `triage` card matches
the intake arm directly. In production the reader is present and returns the merged default
(`intake: "todo"`), so that arm does NOT match and a different branch decides. The mock and
production take different paths through the same function — the test does not exercise the
production shape at all.

## The rule

**Never read a task's workflow synchronously.** Use `resolveWorkflowIrForTaskWithProvenance` and
branch on `source`: `"selection"` is verified by IR identity, so it is the only value that means "this
is really the task's workflow". Treat `"default"` as "unknown" and choose the conservative answer.

This matters for the census conversions specifically: replacing `column === "triage"` with a trait
lookup that resolves through a SYNC reader produces a guard that reads the default workflow's traits
for every task — plausible, wrong, and invisible. It converts a visible literal into a hidden bug.

## Why #6 is not a mechanical await-insertion (checked, not assumed)

I went to convert one \`resolvePlannerLanes\` call site as a worked example and stopped, because every
site is SYNC BY CONSTRUCTION. That is why the sync reader is there in the first place:

  - \`triage.ts\` \`taskColumnWakeHandler\` — a synchronous event-handler callback.
  - \`triage.ts\` dispose handler — same shape.
  - \`triage.ts\` stale-planning sweep — inside an \`allTasks.filter((t) => …)\` predicate.
  - \`executor.ts\` — three further call sites.

You cannot \`await\` inside a \`filter\` predicate or an event handler that callers treat as sync, so
"make it async" is not an edit, it is a restructuring per site.

THE PATTERN THAT WORKS IS ALREADY IN THIS FILE. \`discoverReadyPlanningTasks\` had the same problem and
solved it by PRE-RESOLVING: a store-free \`couldBeCandidate\` prefilter narrows the set, then a bounded
(8) concurrent \`resolveTaskLifecycleColumns\` pass resolves the survivors before the synchronous
decision runs. Each \`resolvePlannerLanes\` site needs that shape — resolve lanes for the candidate set
up front, then keep the predicate synchronous over the resolved map.

For the event handlers the shape is different again: they fire per task, so they want a small cached
resolution keyed by task id rather than a batch pass, invalidated on workflow-selection change.

Estimating from that: this is one slice per site with its own test, not one PR. Recording it so the
next person does not start by trying to add \`await\` and conclude the codebase is fighting them.

## Not fixed here

Each consequence needs its sync call path made async, which is a real slice per site. This document
is the finding; the fixes are follow-ups. #2593 fixed only the one that was mine.

## Cached emitter-carried answers for synchronous lifecycle listeners (FN-8658)

`TaskStore` owns a bounded, short-TTL `TaskLaneCache`. Paths that already resolve a task workflow
warm it with `toTaskMoveLanes`; the central `TaskStore.emit` seam attaches that cached answer as the
optional second argument of `task:updated`. The seam performs only a synchronous Map lookup, so hot
update emitters add neither an IR resolution nor a database query. Local workflow-selection writes
invalidate entries and TTL bounds staleness after another PostgreSQL node changes a selection.

`undefined` means **unknown**, never default or legacy. Subscribers must keep their literal fallback
when `meta?.lanes` is absent rather than consult the default-only sync resolver. That preserves
one-argument listener compatibility while synchronous scheduler and triage edge-trigger handlers can
handle renamed lanes correctly when metadata is present.

Runtime/process bridge emitters (`project-manager`, `hybrid-executor`, and the in-process,
child-process, and remote-node runtimes) deliberately DROP this optional metadata. They emit from
their own EventEmitter rather than a TaskStore; forwarding would widen serialized bridge contracts,
while absent metadata is safe because listeners retain their fallback.
`task-updated-lanes-emit-surfaces.test.ts` exhaustively ratchets core emitters and
`task-updated-lanes-engine-emit-surfaces.test.ts` classifies engine emitters; extend those explicit
tables if a new `task:updated` emitter is added. `task-updated-lanes-bridge-compat.test.ts` pins the
DROP bridge compatibility contract.
