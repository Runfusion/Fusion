---
category: ui-bugs
module: dashboard/components
tags: [lifecycle-columns, column-roles, fleet, react-hooks, async-state]
problem_type: conversion-hazard
applies_when: converting lifecycle-column literals in React components that read column trait flags
---

# Converting a column literal to a role turns a stable value into an async one

Recorded 2026-07-30 while converting `TaskCard.tsx` and `TaskDetailModal.tsx`. Five separate review
rounds each found a real defect in those two files. None was in the conversion itself — every one
came from the same property change, and they are cheap to prevent and expensive to find one at a
time.

**Status of those conversions, stated because an earlier draft of this line got it wrong.** It read
"after converting `TaskCard.tsx` (42 → 0) and `TaskDetailModal.tsx` (30 → 5)" as accomplished fact.
Neither reduction has landed: on `main` both files still measure 42 and 30, and the census baseline
in this very PR records the same. The work is in flight in #2688 and #2698. The hazard below is real
regardless — it was found BY those conversions, and it is what the four review rounds were about —
but a solutions doc that reports unlanded numbers as history is worse than no doc, because the next
reader has no way to tell which of its claims were measured.

## The property that changes

```ts
task.column === "in-progress"      // stable for the lifetime of the render tree
isWipColumn                        // derived from fetched trait flags — CHANGES after first paint
```

Column trait flags arrive from a board-workflows fetch. Until it lands they are `undefined`, and
every role helper falls back to the legacy id — the right answer on a default board, the **wrong**
answer on a renamed one. So a converted role is `false`, then `true`, within the life of one mounted
component.

Every defect below is that fact meeting a React idiom that assumed stability.

## The four forms

### 1. Stale memo

A `useMemo` / `useCallback` whose body reads a role but whose dependency array still lists only
`task.column`. The role flips; the memo does not recompute. Symptom on a custom board: timers,
labels and completion dates frozen at their first-paint values.

Found four instances in `TaskCard.tsx`. **This repo has no `react-hooks/exhaustive-deps` rule**, so
nothing flags it — check by hand, or with an AST pass over every hook in the file.

### 2. Frozen `useState` initializer

```ts
const [showSteps, setShowSteps] = useState(isWipColumn || …);   // runs ONCE
```

Captures the pre-load fallback and never reconciles. Worse than it sounds when the surrounding
section is *itself* gated on the same role: the section does not start collapsed, it **appears
later, already collapsed**, on a card the operator never touched.

Reconcile one-way, and only while untouched — a `touchedRef` set by the user's own toggle. Do not
auto-revert on the reverse transition; closing something a user is reading is worse than the bug.

### 3. Eager action on an unresolved role

An effect that *mutates* state — a tab redirect, a reset, a navigation — firing while flags are
still `undefined`. It acts on the fallback, and the correction never arrives because the action
already destroyed the state it would have corrected.

Guard on resolution and wait. **When one branch is recoverable and the other is not, acting on a
guess should favour the recoverable one.** Showing a tab a moment too long self-corrects; discarding
a deliberate selection does not.

### 4. Stale identity — the one that survives a "resolved" guard

The subtlest, and it defeats the fix for form 3:

```ts
if (workflowMoveMetadata === null) return;   // asks "has it loaded?" — NOT "is it for THIS task?"
```

In a component that stays **mounted across entity changes**, the fetch effect resets the state on a
task change, but it may be *declared below* the consumers. On the render where the task switches,
they run first and see the previous task's flags. Non-null, so the guard passes, and roles resolve
from **another task's workflow** — confidently wrong rather than merely stale.

Tag the payload with the id it describes and compare identity. Do not rely on effect ordering: it is
load-bearing, invisible, and one reorder away from breaking.

```ts
const flagsAreForThisTask = metadata?.taskId === task.id;
const columnFlags = flagsAreForThisTask ? metadata?.currentColumnFlags : undefined;
```

Apply it to the **role bindings**, not only the effects. Reordering effects fixes the call sites you
noticed and leaves the bindings resolving from stale data for everything else.

### 5. Settled-empty mistaken for unresolved — the fix for form 4 introduces this one

Guarding on identity means writing `null` when a lookup returns nothing, or fails — which is
indistinguishable from *"has not resolved yet"*. The guard then never opens, the reconciliation never
runs, and the invalid state persists **forever**. Trading "acts on stale data" for "never acts" is
not a fix.

Resolution has **three** states, not two:

| state | value |
|---|---|
| unresolved | `null` |
| resolved with data | `{ entityId, …payload }` |
| **resolved empty** | `{ entityId }` |

The third still identifies the entity, so consumers know the answer landed and should fall back to
the legacy id — a real answer for a workflow that declares nothing, not a placeholder. Settle the
**failure** path the same way, or a lost fetch leaves the UI waiting on it indefinitely.

**Every fix in this list can introduce the opposite failure. Check that both directions terminate.**

## Checklist for a component conversion

1. Every hook whose body reads a role lists that role in its dependency array.
2. No `useState` initializer reads a role without a reconciliation path.
3. No effect *mutates* state from a role before the flags resolve.
4. If the component persists across entity changes, roles are guarded on **identity**, not on
   non-null — and "resolved empty" is distinguishable from "unresolved", including on the failure
   path.
5. Where a role gates both *whether something shows* and *whether it stays*, convert both together
   — a half-converted pair makes the UI contradict itself, which is worse than either state alone.

## Why this is worth a doc rather than four commit messages

The conversions are mechanical and look finished when the file's census count reaches zero. All four
defects ship green: types pass, existing tests pass, and the default board behaves identically —
because on the default lineage the legacy fallback and the resolved role agree. **They only diverge
on a renamed board, which is precisely the case the conversion exists to support.**

Related: `docs/solutions/architecture-patterns/fleet-self-healing-cluster-scoping.md` records the
engine-side hazard (sync workflow reads) for the same programme.
