---
category: architecture-patterns
module: "@fusion/core, @fusion/engine"
date: 2026-07-26
problem_type: architecture_pattern
component: workflow-graph
severity: high
applies_when:
  - "Moving a built-in workflow node into a different column"
  - "Reasoning about where a graph run starts when there is no durable continuation"
  - "Debugging a card that walks backward out of In progress mid-run, or strands in a pre-WIP column"
  - "Writing a scheduler/release test whose fixture puts a card in the hold column"
tags:
  - workflow-ir
  - column-placement
  - plan-in-place
  - plan-review
  - graph-entry
  - hold-release
  - abort-on-exit
related_components:
  - workflow_graph
  - scheduler
  - triage
---

# The graph entry contract, and why it decides where planning can live

A workflow node's `column` is a lifecycle contract, not a display choice: it decides **who drives the
node**, **whether the card holds a WIP slot**, and **whether anything can move the card onward**.

## The entry contract

**A graph run with no durable continuation resumes at the card's own column — never at `start`.**
(`resolveColumnResumeNode`, `workflow-graph-executor.ts`.)

`ir.columns` is ordered, and that order is the lifecycle order. A run enters at the first node, in
forward pipeline order from `start`, whose column is not *behind* the card's current column. Rework
back-edges and failure edges are excluded, so the entry point is always the main path and never a
remediation node that merely happens to sit in that column.

| Card is in | Resumes at | Why it matters |
|---|---|---|
| `triage` | `start` | nothing is behind it |
| `todo` | `plan` | it still needs a spec |
| `in-progress` | `parse` | **never re-plans**, never moves backward out of WIP |
| `in-review` | `browser-verification` | first *review* node — gates are not skipped |

Before this contract, every continuation-less run — self-healing's graph re-entry, a fresh dispatch,
an operator drag into a processing column — replayed from the first column and dragged the card
backward through columns it had already left, firing `abort-on-exit` on its live session. That
backward drag is the single reason planning nodes used to be pinned to the implementation column.

## Plan-in-place (now the default for every coding workflow)

The whole specification phase — `plan`, `plan-review`, `plan-replan` — runs in the planning lane
(`todo`), so a card under specification never holds an implementation slot. The chain, with the check
each link performs:

```
triage specifies the card (writes PROMPT.md) → finalize moves it to `todo`
  → onSpecifyComplete seeds a plan-review continuation
      ... only if planReviewNode.column === task.column   (seedPreReleasePlanReviewContinuation)
  → drainWorkflowContinuations claims runnable `waitReason:"planning"` items
  → executor.execute() resumes the graph AT plan-review
  → on success the next node is in `in-progress`; the boundary SUSPENDS with a
    `waitReason:"capacity"` continuation instead of moving
  → isUnplannedForExecution sees that continuation and lets the scheduler release
  → executor resumes at `parse`
```

**`todo`, not `triage`.** The planning lane spans both columns, but `triage` is an intake column with
no releaser — a card parked there waits for a human. `todo` carries `hold` + the capacity sweep, and
it is where triage's finalize actually leaves the card. Every plan-in-place check keys on the card's
own column, so the node must be where the card rests.

## The release gate is narrow on purpose

`isUnplannedForExecution` applies its pre-release plan-review gate only when **both**:

1. `planReviewNode.column === task.column` — the plan-in-place shape. Keying on merely "not a WIP
   column" gates every held card against an upstream node their graph never routes through, so they
   can never produce the continuation the gate waits for.
2. The plan-review group is **enabled for that task**. A task with the gate toggled off has no gate to
   enforce, and holding it deadlocks — nothing will ever record the evidence.

## Consequences to know

- **A `todo` card is releasable only once Plan Review passed** (or the graph suspended at the capacity
  boundary). Scheduler/release **test fixtures must model a card that cleared the gate** — add a
  `passed` `plan-review` entry to `workflowStepResults`. A held unreviewed card is the gate working;
  that path belongs to `pre-release-plan-review.test.ts`.
- **Pre-existing cards** sitting in Todo with a real spec and no continuation are re-seeded
  automatically by FN-8592's stranded-hold-continuation sweep. Since 2026-08-13 that sweep is a pure
  backstop: the primary handoff retires its own planning work item atomically with the successor
  install (`retirePredecessorId`), so routine post-planning stranding — which once made the sweep
  the de facto handoff at a ~10-minute delay per card — is a bug, not expected behavior. See
  [planning-handoff-race-silently-strands-plan-review](../logic-errors/planning-handoff-race-silently-strands-plan-review.md).
- **The trace no longer starts at `start`** for a card past intake. Assertions on `visitedNodeIds`
  should expect the card's column entry point.
- **Coding (Ideas) no longer has a private planning shape.** Its planning-node re-home is deleted —
  the default graph it clones is already plan-in-place. It now differs only in intake column and its
  reduced node set.

## Removing a column is a lifecycle-vocabulary refactor, not a workflow edit

Merging Todo into Planning (one column carrying `intake` + `hold`) was implemented and reverted. The
IR change is ten lines and the merge gate stays green — which is exactly the trap. The engine names
`todo` **literally** in ~207 production sites, of which:

- **82 are guards** (`column === "todo"` / `column !== "todo"`) that would silently stop matching. A
  guard that never fires does not fail a test; it disables a recovery path in production.
- **43 are writes** (`moveTask(id, "todo", ...)`) targeting a column the workflow no longer declares.
- **59 more live in the dashboard.**

Converting them means resolving the hold column by trait at each call site (`resolveReboundTarget`,
`columnsWithFlag(ir, "hold")`), and many of those sites have no IR in scope — so it needs plumbing,
not find-and-replace. Do it as its own change, with `reconcileUndeclaredTaskColumns` (already
shipped) handling the rows left behind in the removed column.

## Don't couple UI badges to columns

The dashboard's optional-gate badge was lane-gated on `triage`/`todo`, which silently hid the Plan
Review badge whenever the node ran elsewhere. A gate's **running state** is the signal; the card's
column is not a second opinion on it. Only gate a badge on a column when the gate genuinely moves the
card there (Code Review / Browser Verification → `in-review`).
