---
title: "A lane full of failed cards reported itself full and refused every ready card"
date: 2026-10-10
problem_type: reliability
module: "@fusion/core"
component: column-capacity
tags:
  - capacity
  - wip
  - column-boundary
  - hold-release
  - workflow-suspend
  - failed-task
  - rufu-362
  - saneca
symptoms:
  - "hundreds of `task:workflow-run-suspended` rows with `reason: \"capacity\"` inside half an hour and zero board moves"
  - "`capacity-exhausted` refusal on a `todo -> in-progress` move while `runningAgentCount` reports 0 live agents"
  - "every ready card in the planning lane held with `heldReason: \"downstream-full\"`"
  - "the workflow switcher shows the WIP lane at its limit while nothing is executing"
root_cause: "the in-transaction column WIP counter counted every row in the lane, including dead `status:\"failed\"` parks, while the engine sweep's own mirror and the agent-capacity predicate excluded them"
resolution_type: bugfix
---

## What an operator sees

Nothing is running, and nothing can start. The card sitting in `todo` is refused `capacity-exhausted`;
the whole planning lane is held `downstream-full`; the workflow switcher says the In Progress lane is at
its limit. A `run_audit` query for the last 30 minutes shows only one interesting row type, repeated
hundreds of times — a graph suspend with `waitReason: "capacity"`.

## Mechanism

Three surfaces count "how full is this lane", and they did not agree:

| Surface | Failed park (`status:"failed"`) |
| --- | --- |
| `countActiveInCapacitySlotSync` / `...Async` (in-transaction, authoritative — every move, drag, promote, release) | **counted** |
| `countCapacitySlot` in the hold/release sweep (documented as mirroring the in-txn count) | excluded |
| `isRunningAgentTask` (agent `maxConcurrent` / `maxWorktrees`) | excluded since FN-8704 |

A dead card whose step died parks with `status:"failed"`. It holds no session, no agent slot and no
worktree slot, but it *stays in its lane on purpose* — FN-8704 deliberately keeps failed WIP rows
rendered so an operator can retry or re-home them. The column counter never got that amendment, so
debris occupied real slots.

At a WIP limit of 3, three dead cards therefore made the lane permanently full: the move was refused
inside the transaction, the graph suspended at the column boundary, the sweep — reading through its own
excluding mirror — saw free capacity and held the ready cards `downstream-full` instead, and the same
cycle repeated on every poll. Measured on project `saneca`: 294 capacity suspensions in ~30 minutes,
`runningAgentCount` 0 and `planningCount` 0, zero board-wide moves.

## Fix

Extract the failed-park rule that FN-8704 had already written down inside `isRunningAgentTask` into one
exported predicate, and make every occupancy consumer answer through it:

```ts
export type FailedWipParkShape = { status?: string | null };
export function isFailedWipPark(task: FailedWipParkShape): boolean {
  return task.status === "failed";
}
```

Consumers: both store counters (after the marker-skip arm, so `status:"failed"` plus a
`transition_pending` marker still counts as a live holder), the hold/release sweep's mirror, the
dashboard workflow-switcher phase counts, and `isRunningAgentTask` itself — whose inlined literal was
deleted so a fourth call site cannot reappear with a different answer.

Two scopes were held deliberately narrow. The shared atom is the *failed check only*: adopting
`isRunningAgentTask` wholesale would also drop paused, stale-`planning` and externally-blocked rows from
column occupancy, which is a scheduler-admission change nobody asked for. And the dashboard excludes a
failed park from Progress and Review occupancy only — the Plan bucket reports queue depth, the merge
flash keys on the task's own merge status, and the cards remain rendered.

## Non-obvious details

- **The SQL projection is nullable.** Both counters call the predicate on a raw `project.tasks`
  projection, where `status` is `string | null`, so the predicate takes `{ status?: string | null }`
  rather than `Pick<Task, "status">`. Coalescing at the call sites instead would have been ceremony
  whose only purpose is to be dropped by the next caller.
- **The predicate ships in both core barrels.** `index.ts` and `index.gate.ts` export it, because the
  `engine-core` merge-gate lane resolves `@fusion/core` through the generated gate bundle; a
  full-barrel-only export breaks only the gate lane.
- **The marker-skip arm must stay first.** A live mover has a null `status` *and* a
  `transition_pending` marker; the marker arm counts it, and the failed arm must never see it.

## How the regression test was made non-vacuous

The first draft of the store-level test passed before the fix existed, which is how the bug would have
survived its own test. Two independent reasons, both silent (each helper returned `0`, the expected
number, for the wrong thing):

1. Fixture writes went through the harness's raw `admin_sql()` plane, which may reach a **different**
   database than the store's own drizzle data plane reads from. Writes belong on
   `h.layer().db.update(schema.project.tasks)` with `projectPartition(...)` in the `WHERE` clause.
2. The counter was asked about the `DEFAULT_WORKFLOW_POOL_ID` bucket while the seeded rows were bucketed
   under the card's own selected workflow. Ask about the pool `resolveCapacityPoolId` actually returns
   for the contending card.

The guard that made it provable: assert a **live** occupant reads the expected non-zero count *before*
asserting a failed park reads zero. A positive-exclusion test with no live control is unfalsifiable. A
RED check against the pre-fix counter then confirmed exactly the new exclusion cases fail and the
negative cases stay green.

## Related

- `docs/architecture.md` → *Independent task and worktree concurrency* (the three occupancy dimensions).
- `docs/solutions/reliability/` FN-8704 debris rule: failed WIP rows stay visible.
- `packages/core/src/__tests__/postgres/workflow-capacity-invariant.pg.test.ts` — the invariant suite.
- `packages/engine/src/__tests__/hold-release-capacity-failed-parks.test.ts` — the sweep mirror.
