# Workflow Policy Ownership Map

## Purpose

This map is the U1 characterization artifact for moving merge, retry, scheduling,
and recovery policy into workflow IR/runtime. It classifies current production
branches before code is deleted or moved so later cutover work can prove that no
legacy engine control path was left unowned.

## Ownership Categories

- `substrate`: engine/core mechanics that remain below workflow policy.
- `workflow-policy`: decisions that must be represented by workflow nodes,
  workflow node state, or workflow recovery events.
- `capability`: operations invoked by workflow nodes while still using shared
  guard services.
- `compat-projection`: legacy task fields or records that may remain as
  derived summaries during migration.
- `delete-after-cutover`: branches that should disappear once workflow parity is
  authoritative.

## Catalog

| Surface | Current source | Current owner | Target owner | Disposition |
|---|---|---|---|---|
| Auto-merge queue enqueue and dequeue | `packages/engine/src/project-engine.ts` | `ProjectEngine` merge queue | workflow merge work items and merge-gate nodes | `workflow-policy`, `delete-after-cutover` |
| In-review handoff delay and startup sweep | `packages/engine/src/project-engine.ts` | `task:moved` listener plus in-review scan | workflow completion handoff node creates merge work | `workflow-policy` |
| Manual `onMerge` requests | `packages/engine/src/project-engine.ts` | engine public merge queue entry point | explicit human/manual workflow event that wakes merge node | `workflow-policy`, `capability` |
| Merge request shadow contract | `packages/core/src/store.ts`, `packages/engine/src/project-engine.ts`, `packages/engine/src/merger.ts` | store record plus shadow parity branches | workflow work-item state or compatibility projection | `compat-projection` |
| Merge checkout, integration, conflict resolution, squash, finalize | `packages/engine/src/merger.ts`, `packages/engine/src/merger-ai.ts`, `packages/engine/src/merger-integration-worktree.ts` | merger lifecycle procedures | workflow merge node capabilities calling guard services | `capability` |
| Branch-group member integration and group promotion | `packages/engine/src/group-merge-coordinator.ts`, `packages/engine/src/merge-trait.ts`, `packages/engine/src/merger-integration-worktree.ts` | group coordinator and merger helpers | branch-group workflow subgraph with separate member and promotion nodes | `workflow-policy`, `capability` |
| Merge target and auto-merge eligibility guards | `packages/core/src/task-merge.ts` | shared helper used by engine paths | shared guard service called by workflow nodes | `substrate` |
| Dependency satisfaction treats `in-review` as satisfied | `packages/engine/src/scheduler.ts`, `packages/core/src/task-merge.ts` | scheduler/task helper lifecycle interpretation | workflow completion handoff state and compatibility projection | `workflow-policy`, `compat-projection` |
| Active scope leases include unmerged `in-review` worktrees | `packages/engine/src/scheduler.ts` | scheduler overlap policy | workflow work leases plus repository guard services | `workflow-policy`, `substrate` |
| PR monitor starts/stops from `in-review` transitions | `packages/engine/src/scheduler.ts` | scheduler task-move listener | workflow PR/watch nodes or workflow events | `workflow-policy` |
| Generic agent capacity, routing, claim, and lease mechanics | `packages/engine/src/scheduler.ts` | scheduler | scheduler substrate claiming runnable workflow work | `substrate` |
| Executor retry storm cap | `packages/engine/src/__tests__/executor-retry-storm.test.ts`, `packages/engine/src/project-engine.ts` | engine retry counters and execution loop | workflow node retry policy plus runtime substrate guard | `workflow-policy`, `substrate` |
| Generic backoff helpers | `packages/engine/src/retry-with-backoff.ts`, `packages/engine/src/rate-limit-retry.ts` | helper functions | reusable substrate helper called by retry nodes | `substrate` |
| Transient merge error classification | `packages/engine/src/transient-merge-error-classifier.ts` | helper used by merger/self-healing | merge-node classification input, not route owner | `substrate` |
| Task-level retry summary fields | `packages/core/src/retry-summary.ts`, `packages/core/src/manual-retry-reset.ts` | task metadata and reset patch | compatibility projection from workflow node/run retry state | `compat-projection` |
| Manual retry reset | `packages/core/src/manual-retry-reset.ts`, dashboard/API callers | task metadata patch | workflow event clearing targeted failed node retry state | `workflow-policy`, `compat-projection` |
| Recover mergeable in-review tasks | `packages/engine/src/self-healing.ts` | self-healing directly re-enqueues merge | workflow recovery event wakes merge node | `workflow-policy`, `delete-after-cutover` |
| Completion handoff limbo recovery | `packages/engine/src/self-healing.ts` | self-healing re-emits auto-merge handoff | workflow recovery event or idempotent handoff node wake | `workflow-policy` |
| Transient merge failure recovery | `packages/engine/src/self-healing.ts` | self-healing resets merge retries and re-enqueues | merge-node retry policy and retry-after work item | `workflow-policy`, `delete-after-cutover` |
| Stale merge status recovery | `packages/engine/src/self-healing.ts` | self-healing clears status and may enqueue merge | workflow recovery event plus merge work reconciliation | `workflow-policy` |
| Already-landed and no-op finalization | `packages/engine/src/self-healing.ts`, `packages/engine/src/merger.ts` | self-healing/merger lifecycle paths | workflow recovery/finalize nodes with repository guard services | `workflow-policy`, `capability` |
| Backward in-review recovery paths | `packages/engine/src/self-healing.ts`, `docs/self-healing-backward-move-audit.md` | proof-gated self-healing mutations | workflow recovery nodes; engine only emits facts | `workflow-policy`, `delete-after-cutover` |
| Workflow runtime execution facade | `packages/engine/src/workflow-task-runtime.ts`, `packages/engine/src/workflow-graph-executor.ts` | runtime executes graph nodes | remains workflow runtime owner | `substrate`, `workflow-policy` |
| Built-in default workflow definitions | `packages/core/src/builtin-coding-workflow-ir.ts`, `packages/core/src/builtin-stepwise-coding-workflow-ir.ts`, `packages/core/src/builtin-pr-workflow-ir.ts` | partial lifecycle expression | authoritative source for default scheduling, retry, merge, and recovery regions | `workflow-policy` |
| Dashboard task-card merge/retry/stall badges | `packages/dashboard/app/components/TaskCard.tsx` | task fields and legacy classifications | workflow run/work-item projection first, legacy fields second | `compat-projection` |
| Reliability and diagnostics surfaces | `docs/diagnostics.md`, dashboard reliability views | self-healing and engine status strings | workflow-native recovery and held-work reasons | `compat-projection` |

## Non-Bypassable Guard Services

These remain centralized and are called by workflow node capabilities before
mutating git state:

- File-scope and squash overlap checks.
- Branch target and branch-group target validation.
- Worktree ownership and lease checks.
- Auto-merge processing gate, including `autoMerge:false` terminal-until-human
  semantics and the shared-branch member integration exception.
- Run-audit correlation for git operations and recovery facts.

## Measured Wiring State (2026-07-28, U9 pre-flight)

The S02–S08 substrate is further along than the slice docs claim, but a large part
of it is **built and not driven**. Measured against `main` at `46f35323c`. Recorded
here because "the code exists and its tests pass" reads as landed, and for four of
these that is not the same as running.

| Capability | Implementation | Production callers | Reality |
|---|---|---|---|
| S1 work-item schema + store API | `0031_workflow_task_continuations.sql`, `store.ts` | live | **Wired.** Drives the plan-review continuation path. |
| S02 merge-request projection | `projectMergeRequestToWorkflowWorkItem` | **none** | Built, never invoked. |
| S03 generic scheduler claim | `claimDueWorkflowWorkItem` (`workflow-work-scheduler.ts`) | only the S05 processor, which is itself unwired | Built, never invoked. |
| S04 built-in IR merge regions | `merge-gate`, `merge-retry`, `manual-merge-hold`, `merge-attempt`, `recovery-router` in the coding IR | n/a — declarations | **Landed.** Node *config* is unread; see `u9-merge-region-node-config-authority.test.ts`. |
| S05 runtime work-item driver | `WorkflowTaskRuntime.runWorkItem`, `processDueWorkflowWorkItem` | **none** (exported from `index.ts` only) | Built, never invoked. |
| S06 git/merge capabilities | — | — | Not started. Merge runs through `merger.ts`. |
| S07 completion handoff creates merge work | — | — | Not started. |
| S08 workflow-owned merge processing | — | — | Not started. `ProjectEngine.mergeQueue` is the live pump. |

**The consequence that matters for U9.** `WorkflowWorkItemKind` is
`task | merge | retry | manual-hold | recovery`. The only live pump is
`InProcessRuntime.drainWorkflowContinuations`, and it filters `kinds: ["task"]`.
The generic processor that would claim the other four kinds
(`processDueWorkflowWorkItem`) has no production caller.

**Non-`task` work items are already being written, and nothing claims them.**
`createCompletionHandoffWorkflowWork` (`workflow-workitems-ops.ts:68`) writes
`kind: "merge"` when auto-merge is on and `kind: "manual-hold"` when it is off. It
is called from the LIVE handoff-to-review path (`moves.ts:438` and `:1150`), inside
the move transaction. The kind is computed into a variable
(`autoMerge ? "merge" : "manual-hold"`), which is why a literal grep for
`kind: "merge"` finds nothing — an earlier revision of this section wrongly
concluded there were zero writers on exactly that basis.

So the current state is:

| | State |
|---|---|
| Writers of `merge` / `manual-hold` | **Live** — every task that reaches review writes one |
| Claimers | **None** — the only pump filters `kinds: ["task"]` |
| Reconcilers | **None** — self-healing's continuation check also filters `kinds: ["task"]` (`self-healing.ts:6575`) |
| Only terminalization | The NEXT `createCompletionHandoffWorkflowWork` for the same task cancels prior ones as `superseded-by-completion-handoff` |

These rows therefore **accumulate in a non-terminal state** (`runnable` /
`manual-required`), one per task that reaches review, cleared only if that same task
hands off again.

**This does not stall any merge.** The actual merge is enqueued by
`enqueueMergeQueueInTransaction` in the same transaction, and the legacy
`ProjectEngine.mergeQueue` pump still drives it. The work items are parallel
bookkeeping that nothing consumes yet — accumulating dead rows, not stuck cards.

**What this means for S07.** S07 does not introduce the writer; the writer is
already here. What S07 changes is making those items *authoritative* for the merge
lane. Until the generic pump (S03/S05) is actually driven, promoting these rows from
bookkeeping to authority converts a benign row leak into cards that reach the merge
boundary and stop. **S07 must not land before S03/S05 are driven** — and the
pre-existing unclaimed rows need a reconcile/backfill decision as part of that work.

## Deletion Gates

- No production caller may start checkout, branch integration, squash, or finalize
  except a workflow merge node or an explicit human/manual API that records an
  equivalent workflow event.
- `Scheduler` may claim runnable workflow work, apply capacity/routing/leases,
  and monitor PR/watch substrate events; it must not infer merge eligibility,
  retry routing, or task lifecycle advancement from task columns.
- `SelfHealingManager` may publish typed recovery facts and reconcile metadata;
  it must not directly requeue, pause, fail, unpause, or move merge/retry tasks
  except through guarded workflow primitives.
- Task-level retry and merge fields are compatibility summaries. Workflow
  run/node/work-item state is the policy authority.

