---
category: workflow-learnings
module: packages/engine
tags: [lifecycle-columns, testing, coverage, resolved-lanes, ratchets]
problem_type: process-learning
applies_when: deciding whether a lane conversion is actually protected by a test
---

# Blind the resolver: the only way to know a conversion is covered

See also [silence-is-not-success](./silence-is-not-success.md) — every wrong reading this method
produced came from the RUN, never from the blind itself. Two kinds: a run that never happened (the
swept test file, the silent `exit 2`), and a run that happened but could not measure anything (a
harness that made the blind unobservable, a suite that never reached the blinded site — both below).
Absent output and invalid output read identically at a glance, which is why the rules there are about
confirming what a run actually did rather than about whether it printed a failure.

Sibling to [a-falling-count-is-not-evidence](./a-falling-count-is-not-evidence.md), which records that
a metric moving is not proof the system moved. This one records the **positive** procedure: how to
find out whether a landed conversion is held by anything, and how to write a test that holds it.

Written from the phase where the lifecycle-column backlog went 126 → 10. Measured at the time: of
**64 resolved lane sets in `self-healing.ts`, 26 had no test that could distinguish them from the
literal they replaced** — including three conversions the author had shipped that same day, and two
halves of sweeps already recorded as covered.

## The procedure

Blind one resolver back to its legacy ids, run the file's suites, and look at the result:

```
- const reviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
+ const reviewColumns = new Set<string>(["in-review"]);
```

- suite **fails** → that conversion is covered
- suite **passes** → nothing in the tree can tell the conversion from the literal

One resolver, one 17-second run. Cheaper than writing the conversion was.

## Why the census cannot answer this

The census counts **comparisons**. It cannot tell a working conversion from one a later merge
silently reverted, because both look the same to a syntactic scan. That is how a conversion merged
with 204 green tests behind it and zero of them able to see it.

The two instruments answer different questions and neither substitutes for the other:

| instrument | question |
|---|---|
| census / lane-wiring ratchet | is this site written in the resolved vocabulary? |
| blinding | does anything break if it stops being? |

## Six rules for a test that actually holds a conversion

Each was paid for by a test that passed while proving nothing.

**1. Blind each resolver separately — coverage is per-resolver, not per-sweep.**
A sweep with three buckets can have one covered and the others not. Twice a sweep recorded as done
was half-done: the control flow short-circuited before the second guard was ever consulted, so the
first test could not reach it.

**2. The fixture must reach the branch the resolver gates.**
A card in a renamed *wip* lane cannot exercise a *terminal* skip — it is caught by the wip∪review set
first, and the terminal resolver never decides anything. The test exercises the sweep, passes, and
never touches the line under test.

**3. Assert a path-specific side effect, not a return value.**
In a sweep with several routes to one outcome, `outcome === "reclaimed"` is reachable without the
guarded branch. Assert the thing only that branch does — `removeWorktree`, a `task:reconcile-*` audit
type, a specific `reason` string. Every case that stuck used one; every discard asserted a return
value.

**4. A store fake must honour `options.column`.**
`mockResolvedValue([task])` returns the same row whatever column is asked for, and
`mockResolvedValueOnce` × 3 answers by call order. Blinding then changes which column is *requested*
and identical rows come back. **A fake that ignores its own filter cannot see a filter bug** — which
is exactly the bug these resolvers exist to fix. Use the column-honouring store in
`packages/engine/src/__tests__/self-healing-query-filter-blindness.test.ts`.

**5. The resolver must be able to answer differently in the harness.**
`resolveProjectColumnsForRoles` returns the **legacy ids and nothing else** when the store has no
`listWorkflowDefinitions` — an intentional degrade in `project-lane-vocabulary.ts` so an unreadable
workflow list cannot fail a sweep. A harness that omits that method makes the resolved set and the
literal set *equal by construction*, so the conversion is unobservable no matter how good the
assertion is. This is not a test bug; it is correct production behaviour that erases the difference
the test is trying to measure. Both the `scheduler.ts` and `triage.ts` conversions were unpinned for
this reason alone.

**6. Blinding measures the INSTRUMENT you picked, not the site.**
Before believing a green result, confirm the suite you ran actually executes the file you blinded. A
suite that never reaches the site reports "0 failed" for the same reason a covered one reports it,
and the two are indistinguishable from the output.

This produced a wrong answer twice in one sweep, both times reading as a finding:

| blinded | suite run | said | actually |
|---|---|---|---|
| `reads.ts` ×3 | `search-excludes-renamed-archive-lane.test.ts` | 3 uncovered | that file unit-tests `liveSearchPredicate` and never runs `reads.ts`; against `cold-storage-renamed-archive-lane.test.ts`, which drives `listTasksImpl`, one of the three is covered |
| `server.ts` ×3 | `reliability-metrics.test.ts` | 3 uncovered | that file imports `../reliability-metrics`; nothing executes the route at all |

The `reads.ts` case is the one to remember, because the misleading suite was **written for that exact
conversion**: it proves the collaborator honours a resolved set, which says nothing about whether the
caller passes one. A unit test of the collaborator can never fail when you blind the call site. That
gap shipped as a real hole and was closed in #3220.

Cheap check before trusting a green: make the blinded edit obviously fatal (`throw new Error("x")`)
and re-run. Still green means the suite does not reach the site and the measurement is void.

Fixtures also encode contracts invisible from the resolver: action sites that deliberately skip a
card whose board cannot be read, buckets with their own pause-reason predicates, gates that resolve
the *blocker's* workflow rather than the card's. All were discovered by a test failing first.

## The audit's dominant failure mode is test SELECTION, not blinding

Every wrong reading this method has produced came from running the wrong tests, never from the blind
itself. Three in one session, each of which reads exactly like coverage:

| what I ran | why it lied |
|---|---|
| `vitest run src/__tests__ -t "executor"` | `-t` filters test **names**, not files. Reported two `executor.ts` resolvers uncovered; both are covered. |
| `blind3.py <file> <var>` with an unmapped role | the script exited non-zero **silently**, `&&` skipped the check, `;` let vitest run against **unmodified source**. Reported 375/375 green "under blinding" with nothing blinded. |
| `vitest run src/__tests__/notification` | missed `src/notification/__tests__/` entirely — a nested `__tests__` the glob never reached. Reported covered code as uncovered. |

A fourth, in the opposite direction: **a COVERED verdict needs a baseline.** The dashboard sweep
reported 5 failing files under the global blind; **4 of them fail on clean `main`** and had nothing
to do with lanes (a docs-inventory test, a model-routes test). Read as-is, that is four resolvers
falsely credited as covered. Run the failing set again *unblinded* and subtract — whatever fails in
both is noise. Pre-existing red is common enough in a non-blocking suite that this is not an edge
case; it is the second time today it changed a conclusion.

So: **an UNCOVERED verdict is a claim about the whole tree and needs the whole tree's tests**, and a
COVERED verdict needs a baseline to subtract. Before believing either, confirm (a) the blind actually
modified the TARGET file — `git diff --stat -- <path/to/target>`, not a bare `git diff --stat` and not
the tool's exit code, since an unscoped diff reports any unrelated edit in the tree as though it were
the blind's work, (b) the run included every test file
that imports the module, including nested `__tests__` directories, and (c) the failures you are
crediting do not also fail without the blind. A tool that can no-op must say what it changed and fail loudly when it
cannot; the same standard this program applies to product guards applies to the audit's own
instruments.

## Seed-then-union sites need the right blind

```ts
const sweepColumns = [...new Set(["triage", "todo", ...projectPlannerColumns])];
```

Blinding the resolver to its legacy ids here is a no-op **on a default board** — the seed already
contains them. It is *not* a no-op on a renamed board, where the resolver is the only contributor of
the renamed lane. The rule is narrower than "seed-then-union hides everything": **it hides a defect
only while every lane you assert on is already in the seed.** Blinding to the *empty* set is the
stricter choice, because it also models a resolver that returns nothing at all.

Related: expand roles to legacy ids **per role**, from `LEGACY_COLUMN_IDS_BY_ROLE`, not from a
hand-written whole-list table. `intake` maps to `["todo","triage"]`, not `["triage"]`; a blind that
drops `todo` is *stricter* than the real legacy set, and a stricter blind manufactures failures that
read as coverage the site does not have.

## When the measurement cannot be taken, record that

Three groups resisted blinding for reasons worth writing down, so the next person does not re-derive
them. Recording *why* a site cannot be measured is a result — the same stance #3212 took for a site
that cannot be covered.

- **~~No TCP PostgreSQL.~~ SUPERSEDED — these were measurable and one hid a real gap.** The caution
  itself stands: `pgDescribe` probes **TCP**, `pg_isready` on a **Unix socket** is not the same
  thing, and a skipped suite reads exactly like a passing one. But on an environment where the `.pg`
  suites do run, all 4 resolvers were measured: `workflow-analytics.ts` has **both** halves covered,
  `team-analytics.ts` has `completeLanes` covered and **`activeLanes` uncovered** — a half-covered
  pair in a file named `team-analytics-renamed-lanes`, now pinned. **Before recording a site as
  unmeasurable for environment reasons, confirm the suite actually skips here** — otherwise the note
  converts a real finding into a permanent excuse for not looking.
- **No injectable seam.** `reads.ts`'s incremental-sync scan composes Drizzle conditions against
  `layer.db` directly. A test there would assert the query that was built rather than the rows that
  were excluded — green, and blind to the bug.
- **Logic inside a route closure.** `server.ts`'s three resolvers sit in the
  `/api/health/reliability` handler, which has no route-level test. The only harness in that package
  is a mock-the-world shell, which the slow-test rule forbids; the alternative is a refactor to
  expose a seam, and that is its own commit — moving code and changing behaviour do not ride
  together.

## Two shapes a ratchet cannot distinguish

Found an hour apart, in sibling sweeps:

- **resolved gate, literal branch** — the branch is entered on a resolved question and decided on a
  literal one. Reads as *unwired*; was a live defect (a working agent lost its task link).
- **passed-but-unread** — the parameter is passed but the only field it influences is never read.
  Reads as *wired*; is dead code.

A ratchet counting call sites scores the first as debt and the second as done. Both are wrong. Only
reading the site tells you which you have, which is why that distinction belongs in a comment at the
site and not in a baseline number.

## What has and has not been audited

Measured 2026-07-31: **116 non-test `resolveProjectColumnsForRoles` call sites** across 30 files —
`core` 17 files, `engine` 10, `dashboard` 2, `cli` 1.

`packages/engine` is now fully blinded:

| file | resolvers | result |
|---|---|---|
| `self-healing.ts` | 64 | 21 pinned, 1 recorded inert by construction, remainder mapped |
| `executor.ts` | 2 | already covered |
| `scheduler.ts` | 1 | uncovered → pinned |
| `triage.ts` | 1 | uncovered → pinned |
| `restart-recovery-coordinator.ts` | 1 | already covered |
| `notification/notification-service.ts` | 1 | already covered |
| `evaluator.ts` | 1 | uncovered → pinned |

`project-engine.ts` takes `roles` as a **parameter**, so there is no fixed role set to blind; the
question belongs at its callers.

`evaluator.ts` is worth separating from the rest. `HybridEvaluatorService` had **no test anywhere in
the repo** — four files import the module, none construct it. That is a different failure from the
ones above, where a harness runs the code but cannot see the difference: **no amount of fixture care
helps when the entry point is never called.** Check that something exercises the code at all before
concluding a green blind means anything.

`packages/core` is now fully blinded too — **15 sites, 9 already covered, 6 uncovered, all 6
pinned**:

<!-- The `branch-and-pr-entities.ts` row carries TWO sites (`:445` and `:484`); counting the rows
rather than the sites is what made this read 14/5. -->

| site | verdict |
|---|---|
| `store.ts:874` (downtime wip read) | uncovered → pinned |
| `store.ts:1135` (open-undo finished lanes) | uncovered → pinned |
| `branch-and-pr-entities.ts:445` / `:484` | uncovered → pinned |
| `async-mission-store.ts:1179` (archived) | uncovered → pinned; `:1178` (complete) was covered |
| `task-id-integrity.ts:502` (lineage gate) | uncovered → pinned |
| `reads.ts` ×3, `productivity`/`github`/`gitlab` analytics, `eval-automation`, `task-artifacts-ops` | already covered |

`packages/dashboard` and `packages/cli` complete the sweep — **1 covered, 4 flagged**:

| site | verdict |
|---|---|
| `register-task-workflow-routes.ts:1268` (hold) | already covered |
| `server.ts:1922` / `:1923` / `:1938` | uncovered, **not pinnable without a mock-the-world shell** (see the route-closure note above) |
| `cli/commands/task.ts:660` | uncovered; the glyph decision is inline in `runTaskList`, whose own test file records that driving it needs the same forbidden shell |

The `cli` site deserves one warning. Extracting a pure helper and testing it would look like coverage
and **would not be** — blinding the resolver leaves such a test green, because the helper receives
the set rather than resolving it. The uncovered thing is the *resolve call*, not the decision.

Every `resolveProjectColumnsForRoles` call site in the repository has now been blinded individually.

## When you cannot pin it, say so at the site

One resolver in this program is inert by construction and no test can cover it. That is worth a
comment explaining why — otherwise the next worker either writes a green test that proves nothing, or
deletes the parameter and invites someone to re-add it. Recording *why it cannot be pinned* is a
result, not a failure.
