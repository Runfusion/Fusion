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
| `self-healing.ts:12106` `recoverApprovedTriageTasks` | **no** | clearing a stale `planning` status | `triage.sweepStalePlanningStatuses` (periodic, covers `todo`) | redundant net lost — **cleanup** |
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

- **`usage-limit-detector.ts:126`** — **still broken on `main` at the time of writing**; the fix is
  in PR #2567, which is OPEN and not yet merged. Do not read the row below as "already handled on
  main" — until #2567 lands, a default-workflow card being planned in `todo` is excluded from
  provider-wide parking, so a sibling triage agent hitting a usage limit leaves it running into the
  same limit. The classification here is "owned and fixed in flight", not "no longer an issue".
- **`spec-staleness.ts:95`** — proven safe as-is and merged with #2515. **The mechanical conversion
  is wrong here.** Adding `|| task.column === "todo"` breaks the parked-preserved-progress path:
  after the merge `todo` is both the planner column and the capacity-hold column, so the column can
  no longer distinguish "being planned" from "waiting for a slot". Only status can — and the guard
  already tests status. Leave it alone.

The second is the general warning for this whole audit: **on the merged column, `todo` answers two
different questions.** Any site that used `triage` to mean "is being planned" cannot simply be
paired with `todo`, because `todo` also means "is parked waiting for capacity". Those sites need
status or a trait, not a wider literal.


---

# Open defect: the live move path accepts the deleted column (2026-07-30)

Found while proving U11's caveat 2. **Not fixed** — see the scoping note below. Reproduction and
guard-rails: `packages/core/src/__tests__/live-move-path-undeclared-target.test.ts`.

## The defect

A default-workflow card in Planning can be moved **into `triage`** — a column its workflow no
longer declares — re-creating exactly the stranded state `reconcileUndeclaredTaskColumns` exists to
repair. Measured on a fresh store:

```text
experimentalFeatures.workflowColumns   null            <- no production writer
createTask(...)                        column = "todo"
moveTask("todo" -> "triage")           ACCEPTED
moveTask("todo" -> "bogus-column")     REJECTED: "Valid targets: in-progress, triage, archived"
```

The second rejection is the tell: validation is real, but it is the **legacy `VALID_TRANSITIONS`**
table talking, and that table does not know the card's workflow. Its `todo` row still lists
`triage`.

## Why the workflow-aware check does not run

`moves.ts` gates its workflow-adjacency block — including
`workflowHasColumn(workflowIr, toColumn)` — on `isWorkflowColumnsCompatibilityFlagEnabled`, which
reads the RAW `experimentalFeatures.workflowColumns` key. Nothing writes it, so the block is dead on
the path every real project takes.

**This also means U11's undeclared-source escape hatch in `resolveAllowedColumns` does not run in
production.** It was added (with #2515) so a card stranded in a deleted column would have a legal
move instead of `Valid targets: none`; on the live path that rescue comes from the legacy table
instead. Mutation-verified: stubbing the hatch back to `[]` leaves the operator-move test green.

## Why it is not fixed here

PR #2499 un-gated the CAPACITY check and explicitly scoped validation out:

> SCOPE, deliberately narrow: only the CAPACITY check is un-gated. `workflowIr` stays flag-gated so
> transition VALIDATION keeps its current behavior — the inline path's bare-Error/"Valid targets:"
> contract is unchanged, and none of the Phase A2 divergences are flipped here.

That is a considered decision by the owner of this function, and several suites pin the error
contract it protects. What has changed since is U11: **the legacy table now offers a target the
default workflow does not declare, which it never did before.** That is new input to the scoping
call, not licence to ignore it — so this is handed to U2b with a reproduction rather than patched
from outside.

## Exposure

Narrow but real. U10 already fixed the dashboard move menu to offer only workflow-declared targets,
so the board does not present this. The exposure is the **write path** — REST API, CLI, plugins, and
any stale client — which is why the guard belongs in `moves.ts` rather than only in the UI.

## Guard-rails already in place for the fix

Four passing cases pin what a fix must NOT break: every declared lifecycle move
(`todo -> in-progress -> in-review -> done`), archiving, and a `recoveryRehome` reaching an
undeclared column on purpose (the path that rescues already-stranded cards). Plus a premise test
asserting the compatibility flag really is unset, so the suite fails loudly if that ever changes
rather than silently testing a different code path.

## Coding (Ideas): the U11 merge is already applied — and collapsing `ideas` is a different change

Recorded 2026-07-29, because "coding-ideas IR merge" stayed on the owed list after it had shipped,
and the remaining half of that request is not the same kind of change as the one it shipped.

**The discipline is applied.** `builtin-coding-ideas-workflow-ir.ts` already declares
`{ id: "todo", name: "Planning", traits: [hold(capacity), reset-on-entry] }`, and the node re-home
loop no longer places planning nodes at all — the comment at the loop says why:

> The explicit planning-node re-home is GONE: the cloned default graph is itself plan-in-place now,
> so plan / plan-review / plan-replan already declare "todo".

So this preset plans in place in a column named "Planning", exactly like the default lineage. What
remains undone is only the collapse of the separate `ideas` intake into that column.

**Why that collapse is a product decision, not a conversion.** `builtin-workflows.ts` states the
preset's whole purpose: it "adds a manual 'Ideas' intake in front of the default stepwise pipeline
... from there the graph is identical to the default Coding workflow." The Ideas inbox
(`intake` with `autoTriage: false`) is the only thing distinguishing this preset from the default.
Merging it into `todo` does not simplify the lifecycle — it makes the preset a duplicate of the
default workflow with one trait config changed, so the honest form of that change is "delete the
Coding (Ideas) preset", which is an operator call about a shipped board layout.

**One concrete consequence, stated at its real size.** `isUnplannedStartCreate` in
`task-store/task-creation.ts` discriminates with `task.column !== intakeFacts.intake &&
task.column === intakeFacts.hold` — a card created DIRECTLY into the hold column of a
manual-intake workflow, bypassing intake. If `ideas` and `todo` become one column then
`intake === hold` and that conjunction is unsatisfiable, so the arm becomes dead.

It is NOT a correctness regression: the sibling arm (`task.column === resolvedEntryColumn`) still
classifies the card as intake, so it still receives the bootstrap prompt rather than a generated
spec prompt. I checked that specifically, having first assumed it was a live break — the difference
matters, because "this gate silently stops firing" would block the merge and "this arm becomes
dead code" merely means deleting it in the same change.

**If the collapse proceeds**, the checklist is: delete the `ideas` column and its `start`-node
anchor, repoint `start` to `todo`, add `intake` with `autoTriage: false` to `todo`'s traits, delete
the now-dead `isUnplannedStartCreate` arm, and rely on the U9b legacy-adoption sweep
(`reconcileUndeclaredTaskColumns`) to re-home cards resting in `ideas` — the same mechanism that
carries `triage` rows through the default lineage's merge.

### CORRECTION (same day): the collapse is NOT mechanical — it is contradictory

I implemented the checklist above, ran the suites, and it does not work. Recording the disproof
because the checklist made it look like a fixture update.

The two-column shape works because the triage service SCANS one lane and skips the other.
`replan-target.ts` names the discriminator exactly:

> The real discriminator is which lane the triage service SCANS, which depends on the intake
> column's `autoTriage` config, not on the intake/hold roles alone.

So in Coding (Ideas): `ideas` (intake, `autoTriage: false`) is NOT scanned, `todo` IS, and "promote"
means moving the card from the unscanned lane into the scanned one. That move is the gate release.

Merge them and one column must be both the unscanned manual intake AND the scanned planning lane.
There is no consistent answer:

  - `autoTriage: false` wins -> the column is never scanned, so nothing is ever planned. Cards sit
    with a bootstrap-stub PROMPT.md until the capacity hold releases them, which sends an UNPLANNED
    card into `in-progress` — the FN-7648 invariant ("no unplanned card enters a processing column").
  - scanning wins -> `autoTriage: false` means nothing, the manual gate is gone, and the preset is a
    duplicate of the default Coding workflow.

Evidence: 8 tests fail, and they are not fixtures — they encode the promotion flow itself, e.g.
`store-create-intake-column.test.ts` › "promotes an Ideas-parked task to todo without planning it
(still bootstrap-stub PROMPT.md)". Rewriting them would have required inventing what "promote" means
with no destination column.

**What the collapse actually requires:** a release mechanism for a manual gate that is not a column
move — a per-task promoted flag the triage scan reads, so one column can hold both "not yet
promoted" and "promoted, being planned". That is a new lifecycle signal, not a column merge, and it
is the same shape as the deferred `needs-replan`-to-purpose-built-signal follow-up.

Also correcting step 4 of the checklist above: do NOT delete the `isUnplannedStartCreate` arm.
`autoTriage` is a general trait field (`builtin-traits.ts`), so any custom workflow can declare a
manual intake with `intake !== hold`. The arm is dead only for THIS preset, not in general.
