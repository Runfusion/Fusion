---
category: workflow-learnings
module: packages/core/src/project-lane-vocabulary
tags: [lifecycle-columns, resolved-lanes, arity, project-union, per-task]
problem_type: design-decision
applies_when: choosing between resolveProjectColumnsForRoles and a per-task lane resolution
---

# The project union and the per-task answer are not ranked

Recorded 2026-07-30, after the same reviewer finding arrived on five PRs in one day and got **four
different correct answers**. The instinct the program had built by then — "a union is the lazy option,
resolve per task" — is wrong often enough to be worth writing down, because acting on it shipped a
regression.

`resolveProjectColumnsForRoles(store, roles)` returns every column any workflow in the project gives
the role, unioned with the legacy ids. A per-task resolution answers for one card's own board. Neither
is the better tool.

## The question that decides it

Not "can I resolve per task?" — usually you can. It is:

> **What does over-inclusion cost here, and what does a missing selection cost?**

Those are the two failure directions, and they are asymmetric in a way that changes per call site.

## The four answers, with what made each one right

| site | answer | why |
|---|---|---|
| `awaitingPlanning` board enrichment | **union** | over-inclusion costs one extra file read; the per-card predicate still answers per card, so a widened candidate set cannot produce a wrong badge |
| glasses completion notifier | **narrow** | a notification is an outward action with no downstream narrowing — over-inclusion is a wrong notification reaching a user |
| `workflow-analytics` completions | **narrow, feasible** | the rows carry a workflow id (`GROUP BY`), so the keyed answer was available and the union was simply the wrong arity |
| `team-analytics` totals | **union, accepted** | per-task means one workflow read per task and moving an indexed `COUNT` into JS; the cost is a number an operator reads, recorded rather than paid |
| archived-document guards | **union, after trying narrow** | see below |

## The one that reversed the instinct

`comments-ops.ts` guards whether a card's documents are read-only. Both callers have `taskId`, so the
keyed answer looked available and the arity argument said take it.

Switching to `resolveWorkflowIrForTask` **broke a passing renamed-lane test**: a card in a renamed
archived lane stopped being read-only. The per-task resolver needs the task's own workflow
**selection**, and with none recorded it degrades to the built-in IR, whose archived lane is
`archived`. The project union needs no selection — which is exactly why it caught the renamed card.

The failure modes were not the same size:

- **union**: a live card loses document writes, and only where two workflows reuse one id with
  different traits — a configuration nobody has reported.
- **per-task**: every renamed-lane card with no recorded selection silently becomes *writable while
  archived* — the defect the guard exists to prevent, with a test proving it.

Reverted. The correct fix is **per-task with a union fallback when the selection is absent** — narrow
when the card can answer, broad when it cannot — which needs "no selection" distinguished from
"selection resolved to the default", i.e. the provenance form.

## Rules that fall out of it

1. **A union is not a shortcut.** It is the right answer wherever a card cannot be assumed to have a
   resolvable workflow, because it does not depend on one.
2. **Ask what happens with no selection before converting.** `resolveWorkflowIrForTask` does not fail,
   it *substitutes* the built-in board — so a per-task conversion silently answers with the wrong
   vocabulary exactly where the renamed-board bug lives.
3. **Over-inclusion is free for a read, costly for an action, and misleading for a metric.** Query,
   candidate filter, anything narrowed downstream: union. Notification, move, write gate: narrow.
   Aggregate shown to a human: narrow if the rows are keyed, otherwise accept and record.
4. **Swapping one defect for a bigger one drops a guard count and looks like progress.** That is the
   failure mode `lifecycle-conversions-that-score-as-wins.md` catalogues; this is the same trap
   reached through a correct-sounding principle rather than a careless edit.

## Also unresolved, and related

`resolveProjectColumnsForRoles` seeds only the legacy ids for a project whose workflows declare **no**
lifecycle traits at all, so a hand-authored v2 board with renamed columns and no traits contributes
nothing and its cards are invisible to every sweep that queries by role. The three-state rule at
project scope. The fix cannot be a changed default for the reason above — sweeps want the widening and
the aggregators do not — so it wants an opt-in
(`{ untraitedProject: "declared-columns" }`). Recorded at three call sites in `self-healing.ts`.
| `releaseGate` board enrichment | **union** | shares `awaitingPlanning`'s hold-lane union and request cap, with a per-request workflow-IR cache; it includes timestamped evidence because retaining a stale Promote decision is unsafe |
