---
category: architecture-patterns
module: workflow-resolved-columns
date: 2026-07-30
problem_type: systemic_gap
component: engine
severity: high
applies_when:
  - "Converting a lifecycle-column guard whose body performs a moveTask"
  - "Reading the lifecycle-column census total as the remaining work"
  - "Auditing what a renamed board breaks"
tags:
  - workflow-resolved-columns
  - column-census
  - move-task
  - census-invisible
---

# A guard and its `moveTask` are two halves of one conversion, and the census only counts one

## The shape

```ts
if (task.column !== "in-review") { … return; }     // the census counts THIS
…
await this.store.moveTask(taskId, "in-progress");  // and cannot see THIS
```

The census is an AST scan for **comparisons** against a lifecycle id. A `moveTask` destination is a
**call argument**, so no entry in the backlog ever points at one. Converting the guard alone is worse
than leaving both: the handler starts *admitting* work on a renamed board and then tries to move the
card into a lane that board may not declare.

Hit twice in one week, both times only because the guard next to it was being converted:

- `auto-recovery-handlers/branch-worktree.ts` — the counted guard was `task.column === "in-progress"`;
  the invisible half was `moveTask(task.id, "todo", …)`, requeuing into a lane that may not exist (PR
  #2797).
- `pr-comment-handler.ts` — the counted guard dropped a GitHub "changes requested" review; the
  invisible half was `moveTask(taskId, "in-progress")` (PR #2807).

## The measurement

Across `packages/core`, `packages/engine`, `packages/dashboard`, `packages/cli` and `plugins`,
excluding `__tests__`/`*.test.*` and comment lines:

| | count |
| --- | ---: |
| hardcoded `moveTask` destinations in production | **51** |
| …passing `recoveryRehome: true` — **deliberate**, see below | 22 |
| …plain, i.e. rejected on a board that does not declare the target | **29** |

The plain 29 at the time of measurement, by file. **13 have since been converted** on this branch and
in PRs #2797/#2807 — the parenthesised entries are done, and the count stands at **16 remaining**:

```text
  6  packages/engine/src/self-healing.ts          (all 6 sit in query-gated sweeps — see below)
  3  plugins/fusion-plugin-even-realities-glasses/src/agent-actions.ts
  2  packages/cli/src/extension.ts
  2  packages/engine/src/replan-target.ts         (both are COMMENT lines, not call sites)
  1  packages/dashboard/app/utils/appLifecycle.ts
  1  packages/engine/src/project-engine.ts
  ---- converted ----
  3  packages/engine/src/executor.ts              (done)
  2  packages/engine/src/project-engine.ts        (done)
  2  packages/engine/src/recovery/foreign-only-contamination.ts   (done)
  2  packages/cli/src/commands/task-lifecycle.ts  (done)
  1  packages/core/src/duplicate-intake.ts        (done)
  1  packages/core/src/duplicate-guard.ts         (done)
  1  packages/engine/src/auto-recovery-handlers/contamination.ts  (done)
  1  packages/engine/src/restart-recovery-coordinator.ts          (done)
  1  packages/engine/src/pr-comment-handler.ts    (done, #2807)
```

**`self-healing.ts`'s 6 are deliberately last.** Every one sits inside a sweep whose task list comes from
a hardcoded `listTasks({ column: … })` filter, so on a renamed board the sweep returns no rows and the
`moveTask` below it is never reached. Converting those destinations changes nothing observable until the
query layer is fixed — see the sibling doc on self-healing. Converting them first would look like
progress and deliver none.

Three shared resolvers now cover the converted sites, in `workflow-lifecycle-traits.ts` beside
`resolveTaskLifecycleColumns`: `resolveReboundTargetForTask`, `resolveArchiveTargetForTask`,
`resolveWipTargetForTask`. Use them rather than re-deriving a destination per call site.

Re-measure with:

```bash
grep -rn 'moveTask(' packages/*/src packages/dashboard/app packages/cli/src plugins \
  --include=*.ts --include=*.tsx | grep -v __tests__ | grep -v '\.test\.'
```
then split on whether `recoveryRehome: true` appears in the option object.

## The 22 are NOT defects — do not "fix" them

`moves.ts` deliberately exempts them:

```ts
const recoveryToLegacy =
  options?.recoveryRehome === true && (COLUMNS as readonly string[]).includes(toColumn);
if (!workflowHasColumn(workflowIr, toColumn) && !recoveryToLegacy) { throw … }
```

The comment there records why (#1411): a custom-workflow card stranded in an undeclared column must
still be rescuable to a legacy safe-landing column, or it can never be recovered at all. A sweep that
"converts" these re-homes removes the rescue path.

## Why this got sharper recently

The `workflowHasColumn(workflowIr, toColumn)` rejection used to sit inside a block gated on
`isWorkflowColumnsCompatibilityFlagEnabled`, which reads a raw settings key **nothing in production
writes** — so the check did not execute and the legacy `VALID_TRANSITIONS` table decided instead. U12
hoisted it out of that dead branch, and it is now live and unconditional whenever the workflow resolves.
Proven on a real store by `packages/core/src/__tests__/live-move-path-undeclared-target.test.ts`:

```text
moveTask(card in "todo" -> "triage")  now REJECTS: /Unknown column for this workflow/
```

That changed the failure mode of all 29. **Before**, a hardcoded destination silently landed the card in
an undeclared column — invisible to every trait-driven sweep until reconciliation re-homed it. **Now** it
throws. Whether that surfaces or disappears depends entirely on whether the caller catches, which is
per-site and is **not** measured here — do not read "29" as "29 crashes".

## The one remaining non-blocked site, and why it is not converted

`packages/dashboard/app/utils/appLifecycle.ts:245` — the CLI-session **cancel** action, `deps.moveTask(session.id, "todo")`. Its dependency type pins the literal in the signature itself:

```ts
moveTask: (id: string, column: "todo") => Promise<unknown>;
```

Converting it needs the resolved hold lane threaded from the caller (`App.tsx#handleCliAction`), and there is **no resolved-columns map in that scope** — the app-side convention is an optional `columnFlagsById` passed down, as `deriveStatsFromTasks` does, and App does not have one here.

Adding the parameter without wiring it would be an **unwired parameter**, which is precisely the anti-pattern the caller audit (#2803) removed five of. So this is left for the dashboard-app owner, who can introduce the map at the same time. One site, recorded rather than half-done.

## What to do

1. **Convert the pair or neither.** When a census entry sits in a function that also performs a
   `moveTask`, the destination is in scope for the same change. Resolve it — `resolveReboundTarget(ir)`
   for a rebound, the appropriate `columnsWithFlag(ir, …)` lane otherwise — and keep the legacy id as
   the fallback.
2. **Guard the move.** Even a resolved destination can be rejected (a deleted task, a guard, capacity).
   Catch at the move, record an audit row naming the actual failure, and do not let a recovery handler
   die on it — see `branch-worktree.ts`, where the rejection is classified from
   `TransitionRejectionError.rejection.code` rather than by message match.
3. **Do not clear state before the move.** If the move can be rejected, anything cleared beforehand is
   lost with no requeue. `branch-worktree.ts` cleared `branch`/`baseCommitSha` first and destroyed the
   only pointers back to the work on a rejected move.

## Related

- `docs/solutions/architecture-patterns/self-healing-sweeps-are-blind-on-a-renamed-board.md` — the other
  census-invisible class, where a hardcoded `listTasks({ column })` filter means the guard never runs at
  all.
- `docs/solutions/test-failures/optional-flags-seam-hides-unconverted-column-guards.md` — the census
  counts syntax; its "literal COLLECTION" section is the third invisible class (array/`Set` membership).
- `packages/core/src/__tests__/live-move-path-undeclared-target.test.ts` — the live proof that the
  rejection now fires.
