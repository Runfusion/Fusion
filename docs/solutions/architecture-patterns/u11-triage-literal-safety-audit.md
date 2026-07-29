---
category: architecture-patterns
module: "@fusion/core, @fusion/engine, @fusion/dashboard"
date: 2026-07-29
problem_type: migration_audit
component: workflow-columns
severity: high
applies_when:
  - "Landing U11's deletion of `triage` from the default coding workflow"
  - "Deciding whether a `column === \"triage\"` site is broken by that deletion"
  - "Counting the remaining lifecycle-literal conversion surface"
tags:
  - workflow-columns
  - u11
  - migration
  - literal-conversion
related_components:
  - workflow_graph
  - triage
  - self-healing
  - dashboard
---

# The `triage` literal surface, measured per site

U11 merges Todo into Planning by keeping the id `todo` and **deleting `triage`** from the default
coding lineage. Every surviving `column === "triage"` comparison is therefore a candidate for
silent breakage — a guard that stops matching does not fail a test, it disables a path.

This audit exists because the headline count is misleading in both directions, and shipping the
deletion on top of an estimate is how a green merge produces a broken board.

## The count, and why the headline number is wrong

Program-level tracking cited **58** `triage` comparisons. Measured directly with the same pattern
across `packages/*/src` + `packages/dashboard/app`, excluding tests:

| | count | meaning |
|---|---:|---|
| Raw `=== "triage"` / `!== "triage"` | **87** | the grep everyone quotes |
| — inside comments | 1 | not code |
| — **not a column at all** | **15** | `role`, `agentType`, `sessionPurpose`, `surface`, `entry.agent` |
| **Column comparisons** | **71** | the only ones the deletion can reach |
| — OR-paired with `"todo"` in the SAME expression | **32** | a merged Planning card still matches |
| **Exclusive `triage`, needing individual proof** | **39** | the real work list |

Two things this changes:

1. **15 of the 87 are not lifecycle columns.** `agent-prompts.ts`'s `role === "triage"`,
   `tool-availability.ts`'s `surface === "triage"`, `skill-resolver.ts`'s
   `sessionPurpose === "triage"`, `TaskChatTab.tsx`'s `entry.agent === "triage"` — these name the
   **planning agent**, not the planning column, and are unaffected by any IR change. Converting
   them would be actively wrong. A file-level count cannot see this distinction.

2. **32 more are already safe** because the branch accepts `todo` in the same expression. A card
   that used to be in `triage` is now in `todo`, so it still matches. These need no change and no
   test.

So the surface that actually gates U11 is **39 sites**, not 58 and not 87.

## Why "not a column" is not a technicality

`triage` is overloaded in this codebase: it is a column id, an agent role, a session purpose, and
a prompt-template family. Only the first is affected by the IR. A conversion sweep driven by the
raw grep would rewrite the other three, and the resulting failure — a planning agent that no
longer resolves its own prompt template — would look nothing like a column bug.

## The safety rule

After the merge, a default-workflow card that used to rest in `triage` rests in `todo`. So:

- **SAFE** — the site's `triage` branch also accepts `todo`, or resolves by trait
  (`flags.intake`/`flags.hold`), or compares a resolved entry column rather than a literal.
- **NEEDS PROOF** — the `triage` branch is exclusive. Then ask: *when this stops matching for a
  default-workflow card, what does the operator lose?* If the answer is nothing, the site is dead
  for that lineage and safe. If the answer is an affordance or a recovery path, it is breakage.

`triage` remains a **live column id** for `builtin:legacy-coding`, Coding (Ideas), every linear
built-in, and any user-authored workflow (R11). So these guards do not go dead — they go
**workflow-dependent**, which is harder to detect than dead. That is the reason for per-site proof
rather than a sweep.

## The 39, by owner

Ownership follows the program's file assignments; this audit does not claim them.

| File | sites | owner |
|---|---:|---|
| `engine/src/self-healing.ts` | 7 | capacity worker |
| `dashboard/src/routes/register-task-workflow-routes.ts` | 6 | U12 worker |
| `dashboard/app/components/TaskCard.tsx` | 6 | U12 worker |
| `core/src/task-store/task-creation.ts` | 3 | see note — already mitigated |
| `engine/src/replan-target.ts` | 3 | U7 worker (2 are comments) |
| `dashboard/app/components/ListView.tsx` | 3 | U12 worker (1 is a comment) |
| `dashboard/app/components/TaskDetailModal.tsx` | 2 | U12 worker |
| `dashboard/app/components/TaskContextMenu.tsx` | 2 | already trait-paired — safe |
| remaining 7 files | 1 each | scattered |

### Already resolved or safe on inspection

- **`TaskContextMenu.tsx:143`** — `column === "triage" || flags?.intake || flags?.hold`. Already
  trait-paired (U10). The literal is a legacy fallback, not the decision.
- **`task-creation.ts:493/863`** — `isIntakeColumn` ORs the literal with the **resolved** entry
  column, so a merged Planning card matches through the resolved half. The expression-level pairing
  check misses this because it pairs on the literal `"todo"`, not on a resolved variable. Mitigated
  further by the `resolveDefaultWorkflowIntakeColumn` fix already on this branch.
- **`replan-target.ts:100`, `ListView.tsx:659`** — prose inside comments describing the old
  behavior. No code effect.

### Flagged as a real behavior change, not yet owned

- **`TaskCard.tsx:1927`** — `taskColumnFlags?.intake === true && task.column !== "triage"`. The
  literal here is a **narrowing**: it suppresses the Start affordance on the legacy intake column.
  After the merge a default Planning card has `intake === true` and `column === "todo"`, so the
  narrowing stops applying and **Start begins rendering on default Planning cards where it
  previously did not**. That is an operator-visible affordance change, and it is the kind that the
  Surface Enumeration rule exists to catch. It needs an explicit decision, not a mechanical
  conversion.

## Do not land the deletion on an estimate

The instruction that produced this audit was correct: verify per site, do not assume. The measured
result is that the work list is **32% smaller** than the tracked figure, that **15 sites must not
be converted at all**, and that at least one site changes an operator-visible affordance in a way
no column-conversion sweep would have surfaced.


---

# Post-merge blast-radius pass (2026-07-29)

#2515 merged, so the `triage` guards are live-broken for default-workflow cards rather than
hypothetically so. This section answers, per high-stakes site: **does it still fire, what silently
stops happening, and is there a backup?**

Prioritised by blast radius rather than count. A recovery sweep that stops running matters more
than a label that reads wrong.

## Headline: no hard stall found in the recovery block

The alarming reading — "the orphaned-planning-status sweeps stop finding default cards, so a card
whose planner died sits with `status:"planning"` forever, invisible to discovery" — **does not
hold**, and the reason is worth recording so nobody re-derives the panic.

`triage.ts`'s `sweepStalePlanningStatuses` is the PERIODIC primary for that repair and it already
tests `t.column !== "triage" && t.column !== "todo"` — it covers the merged column. The two
self-healing sweeps below perform the same repair and are **redundant safety nets**, not the sole
rescue.

That distinction is the difference between a P0 and a cleanup, and it is only visible by reading
the backup path rather than the broken guard.

| site | fires for a default card? | what stops happening | backup | verdict |
|---|---|---|---|---|
| `self-healing.ts:12106` `recoverOrphanedApprovedTriageTasks` | **no** | clearing a stale `planning` status | `triage.sweepStalePlanningStatuses` (periodic, covers `todo`) | redundant net lost — **cleanup** |
| `self-healing.ts:12427` `recoverOrphanedPlanningTasks` | **no** | same repair | same | redundant net lost — **cleanup** |
| `self-healing.ts:2961/2981/3016` `recoverAdvancedTriageTasks` | **no** | re-homing a card with a worktree + durable IR pin to its pinned resume column | hold-release still releases it on capacity (it has a real spec, so `isUnplannedForExecution` is false) | **degraded, not stuck** — the card takes the capacity path instead of resuming at its pinned node |
| `self-healing.ts:12254` `recoverStarvedRefinementTriageTasks` | **no** | a bounded priority nudge for starved refinements | none needed — the doc comment states it is a nudge, not a rescue | **low** |
| `self-healing.ts:12151` | **yes** | — | already ORs `triage \|\| todo` | **safe** |
| `self-healing.ts:9151` | **yes** | — | already ORs `dep.column === "triage" \|\| "todo"` | **safe** |

`recoverAdvancedTriageTasks` is the one worth fixing first in that file: it is the only site in the
block whose loss changes where a card resumes rather than merely removing a duplicate repair.

Note `:3016` has a second-order effect. It skips when `resumeColumn === "triage"` — a guard against
resuming a card into the column it already occupies. Post-merge the pinned column would be `todo`,
which is no longer skipped, so if the sweep is repaired by pairing the literal at `:2961` **without
also pairing `:3016`**, it will attempt a `todo → todo` move. Repair the three together.

## Already resolved — do not re-fix

Two sites in the ownership split are already handled, and one of them has a **wrong** obvious fix:

- **`usage-limit-detector.ts:126`** — fixed in PR #2567. Real breakage: the planning lane stopped
  being recognised, so a card being planned was neither parked when its provider hit a usage limit
  nor resumed when it recovered.
- **`spec-staleness.ts:95`** — proven safe as-is and merged with #2515. **The mechanical conversion
  is wrong here.** Adding `|| task.column === "todo"` breaks the parked-preserved-progress path:
  after the merge `todo` is both the planner column and the capacity-hold column, so the column can
  no longer distinguish "being planned" from "waiting for a slot". Only status can — and the guard
  already tests status. Leave it alone.

The second is the general warning for this whole audit: **on the merged column, `todo` answers two
different questions.** Any site that used `triage` to mean "is being planned" cannot simply be
paired with `todo`, because `todo` also means "is parked waiting for capacity". Those sites need
status or a trait, not a wider literal.
