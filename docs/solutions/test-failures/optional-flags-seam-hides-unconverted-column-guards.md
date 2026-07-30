---
category: test-failures
module: workflow-resolved-columns
date: 2026-07-31
problem_type: test_blind_spot
component: testing
severity: high
applies_when:
  - "Converting a lifecycle-column literal to a resolved role (the column-census backlog)"
  - "Reviewing a conversion PR whose existing suite stayed green"
  - "Adding an optional parameter that changes behaviour only when supplied"
tags:
  - workflow-resolved-columns
  - column-census
  - optional-parameter
  - revert-proof
  - fleet
---

# An optional-flags seam keeps the whole existing suite green — through the conversion AND through a broken one

## The problem, measured

Every conversion in the workflow-resolved-columns program uses the same seam: a caller passes resolved
trait flags (or a `LifecycleColumns`), and the helper falls back to the legacy column id when they are
absent.

```ts
export function isCompleteColumnRole(flags: ColumnRoleFlags | undefined, columnId: string): boolean {
  return flags ? flags.complete === true : columnId === LEGACY_COMPLETE_COLUMN_ID;
}
```

The fallback is correct and must stay — flags are legitimately absent during first paint and for a card
in a column its workflow no longer declares. But it has a consequence that bit four consecutive files:

**every pre-existing test omits the flags, so every pre-existing test asserts the fallback.** The suite
therefore passes:

- before the conversion (the literal is the answer),
- after a correct conversion (the fallback returns the same answer), and
- after a *wrong* conversion, as long as the fallback is intact.

Measured instances, all in files whose suites were fully green at conversion time:

| file | pre-existing cases that could not detect the conversion |
| --- | --- |
| `github-tracking-reconciler.ts` | 33 (fake store had no workflow reader) |
| `TaskReviewTab.tsx` | 45 (`columnFlags` omitted everywhere) |
| `task-age-staleness.ts` | 12 (`context.lifecycle` omitted everywhere) |
| `plan-approval-hold-invariant` (drain) | 25 (`opts.lifecycle` omitted everywhere) |

In each case the conversion was verified only because a NEW case supplied flags. Without that, "the
suite is green" carried no information about the change at all.

## Why the usual instinct — a renaming test — is not enough either

The natural property is "hold the traits fixed, change the id, behaviour is identical". That catches a
site still reading the id **only when the id no longer matches anything**. It does not catch the
commonest real shape:

```ts
// Not a fallback — an override. The id wins even when traits disagree.
return column === "in-review" || flags?.mergeBlocker === true;
```

Renaming `in-review` to `checking` leaves this correct, because the trait arm answers. The defect
appears in the *converse* direction: a column that still **carries** a lifecycle name while its traits
say otherwise — which is what a project gets by repurposing a default column rather than renaming one.
That direction found a live "Merge & Close" offered on a mid-implementation card
(`TaskContextMenu`, PR #2718).

## What to require

For any conversion in this program, at least one test must **supply flags/lifecycle**, and the PR must
state the measured revert result. Concretely:

1. **A flags-supplying case.** If every case in the file omits the new parameter, the conversion is
   untested in both directions.
2. **Both directions where both are reachable.** Traits-say-role-but-id-differs (renamed lane), and
   id-says-role-but-traits-differ (repurposed column). The second is the one an unconditional `||`
   gets wrong.
3. **A non-vacuous companion.** Assert something the widened predicate must still *exclude*, or a
   predicate matching every column satisfies the new cases. (`TaskReviewTab` and the dispatch filters
   both needed this; without it a filter returning `true` everywhere passed.)
4. **Run the revert.** Restore the literal, run the new case, record the failure text in the PR. Twice
   in this program a new case passed with the change reverted — once because the branch was gated behind
   an unwired handler (`refine` needs `onOpenRefine`), once because the hook was dispatched by trait and
   the test IR did not declare that trait, so the hook never ran at all.

## Why this is documentation and not a ratchet

I tried to automate it: AST-scan for role-helper call sites (sound — 31 consumer files, 66 call sites),
then match each against a test file containing a "renamed vocabulary".

**The detection half is unsound and I did not ship it.** The renamed ids used across this program —
`building`, `checking`, `converted`, `published`, `backlog` — are ordinary English words that appear in
unrelated test prose, and a test merely *importing* the module under test does not prove it exercises
the role path. The scan reported `TaskCard.tsx` as covered by `Column.test.tsx` on a filename
coincidence. A guard built on that reports coverage that does not exist, which is worse than no guard.

A sound alternative — pin the consumer-file set and require each new one to declare its status — was
also rejected: a 31-entry status inventory conflicts with every concurrent fleet PR that adds coverage,
which is the same churn already removed from the census baseline by dropping its derived aggregates
(see `scripts/lifecycle-column-census.mjs`).

So the requirement lives here, as a review criterion, until someone finds a sound signal. The honest
version of the automated attempt is recorded above so it is not re-attempted from scratch.

## Related

- `docs/solutions/test-failures/store-fake-defects-that-masquerade-as-production-bugs.md` — the adjacent
  failure, and the reason the two are separate entries. There, a hand-rolled fake is MISSING a method the
  production path needs, so a branch silently does not run and the production code looks wrong. Here the
  fake is complete and the test is correct; the *parameter* is absent, so the production path runs its
  documented fallback and the test is right about the wrong configuration. A reader debugging "my branch
  never ran" wants that entry; a reviewer asking "would this suite have noticed?" wants this one.
- `scripts/lifecycle-column-census.mjs` — the authoritative count of remaining literals.
- `packages/core/src/__tests__/archived-column-gate-parity.test.ts` — the archived gate is enforced in
  three encodings (TypeScript, Drizzle, raw SQL); converting one alone is a split brain.
- `packages/dashboard/app/components/__tests__/column-role-id-invariance.test.tsx` — the renaming
  property, and a note on why it is only half the invariant.
- `packages/dashboard/app/utils/columnRoles.ts` — why the id fallback exists and must not be deleted.
