---
category: test-failures
module: "@fusion/engine"
date: 2026-10-31
component: overlap / file-scope unit cluster (scheduler starvation, continuation-wake CAS, completion fan-out)
severity: high
problem_type: systemic_gap
root_cause: incomplete_setup
resolution_type: harness_fidelity
tags:
  - RUFU-330
  - file-scope-lease
  - compare-and-set
  - checkout-emptiness
  - stale-fixture
  - test-honesty
applies_when:
  - "A unit file for a compare-and-set seam returns 'unchanged' for a transition the production caller should have won"
  - "One engine test file reports 30+ failures while the PostgreSQL tests of the same seam stay green"
  - "A scheduling fixture asserts admission behaviour that depends on a `git`-backed checkout-emptiness verdict it never declared"
  - "A fixture keeps a queue-order or precedence assertion alive with a field the type contract no longer has"
---

# The overlap/file-scope unit cluster was red while its pg layer was green

RUFU-330 took ownership of three red unit files and found **no product regression in the
overlap/file-scope lease protocol**. Every failure was a fixture that had stopped modelling the
contract production actually enforces. One unrelated production defect surfaced on the same path and
was fixed (a lost `export`). The cluster is the only unit-level cover for the file-scope lease
protocol, which is why a red-but-unowned cluster is not a cosmetic problem: it silences the seam.

## Symptom as reported

| File | Reported |
| --- | --- |
| `packages/engine/src/__tests__/scheduler-overlap-starvation.test.ts` | 32 failed / 7 passed |
| `packages/engine/src/__tests__/file-scope-continuation-wait.test.ts` | 3 failed (both `settlePlanningContinuationDispatch` cases + the `releaseFileScopeWaitingContinuations` wake case) |
| `packages/engine/src/__tests__/self-healing-completion-fanout.test.ts` | 1 failed ("uses the holder workflow rather than a project-wide terminal column union") |

…while `@fusion/core`'s pg tests of the *same* seam — `overlap-wait-release`, `overlap-wait-persistence`,
`queued-episode-transition` — exited 0. That contradiction is the single most useful clue in this class
of bug, and it is explained below rather than treated as noise.

## The CAS contract the fake could not express

`settlePlanningContinuationDispatch` and `releaseFileScopeWaitingContinuations`
(`packages/engine/src/runtimes/in-process-runtime.ts`) are fenced transitions. Both take an
`expectedState` **and** an `expectedLeaseOwner`, and both judge success on the **returned row**, never
on the call having been made:

- `settlePlanningContinuationDispatch` derives `targetState` from the live task row — `held` with
  `blockedReason = "file-scope:<blockerId>"` (or `dependency:<id>`) while the card is `queued` behind a
  blocker, otherwise `runnable` — patches `leaseOwner: null` under
  `expectedState: "running", expectedLeaseOwner: input.leaseOwner`, and returns `"unchanged"` unless
  `transitioned.state === targetState && transitioned.leaseOwner === null` (plus the reason match in the
  waiting case).
- `releaseFileScopeWaitingContinuations` refuses the release before touching a row when
  `task.overlapBlockedBy != null || task.blockedBy != null`, considers only items in `state: "held"`
  with `leaseOwner === null` and the exact `file-scope:<blockerId>` reason, and counts a wake only when
  the **returned** row is `{ state: "runnable", leaseOwner: null }`.

The test's fake answered `{ id, state, blockedReason }` — a row with **no `leaseOwner` key at all** — and
ignored both fences. `leaseOwner: undefined !== null` therefore made *every* honest call look like a lost
CAS, and the assertions were structurally unsatisfiable: no change to production could have turned them
green. A fake that merely collects patches is worse than no fake, because the seam's ownership fence
looked covered while it was never executed.

The repair copies the shape the honest exemplars already use
(`stranded-continuation-owner-routing`, `workflow-file-scope-continuation-wake`,
`triage-planning-continuation-lease`, `overlap-resume-production-chain`): the fake owns mutable rows,
refuses a fenced transition by returning the **untouched live row** — which is exactly what
`packages/core/src/task-store/async/async-workflow-workitems.ts` does for a CAS loss, an ordinary
outcome rather than a throw — applies every non-`expected*` patch field, and returns the post-transition
row including `leaseOwner`. Two cases were then **added**, because the honest fake can finally express
them: a stale `expectedLeaseOwner` yields `"unchanged"` with no `kick()`, and a `blockedBy` wedge keeps a
wait parked even after `overlapBlockedBy` cleared.

## Why pg was green and the unit files were red

The pg tests run against `TaskStore.moveTaskIf`-grade real storage: the transitions there are SQL
`UPDATE ... WHERE lease_owner = ?` statements, so the fence is enforced by the database and cannot be
stubbed away. The unit files run against hand-written fakes, and a fake drifts silently the moment
production adds a required input field — nothing fails at the fake, only at the assertion two lines
later, which reads like a product bug. **A green pg layer over a red unit file is therefore evidence
about which side is stale, not a paradox.** Measure the pg lane before touching production code; then
diff the production input/return contract against what the fake returns.

## Per-cluster root-cause verdicts

| Cluster | First error | Verdict | Repair |
| --- | --- | --- | --- |
| file-scope continuation wake | `expected 'unchanged' to be 'waiting'` | **Harness.** The fake predates the lease-owner fence and returned a row without `leaseOwner`. | Honest CAS fake + the two new refusal cases. |
| completion fan-out | dependent's `overlapBlockedBy` came back `null` instead of the holder id | **Harness.** FN-509 (`fa5cdf67ce`) deleted `Task.priority`; the fixture bought holder precedence with `priority: "high"` under an `as Task` cast, so both cards tied on `createdAt` and the id tiebreak put the *dependent* first, and a dormant holder only blocks when it wins `compareTasksByQueueOrder`. | The holder is now honestly older than its dependent; dead `priority` keys removed. Negative control: inverting arrival order turns exactly this case red. |
| scheduler overlap starvation | one systemic `column: "todo"` on every dispatch assertion | **Already repaired on `main`** (RUFU-319, `d246ab7bfe`): `checkPlanPremises` fails closed with `plan-premise-unavailable` when `getTasksDir()` points at a directory that was never created, so no card ever released. Running the *base* copy of the file against current production reproduces `32 failed / 7 passed` exactly, so the report was real; the checkout-emptiness-prover theory that had been recorded against it is disproved by the same probe (the fake's `/tmp/project` rootDir stayed and the run went green). | Nothing to fix here; the file's own note now states the premise-document requirement, and the lease verdict is declared per case. |

Three production invariants were explicitly tested for a break and all three held: a dormant holder is
released **only** on a proven-`empty` checkout (`unknown` from an unparseable `git` stdout keeps the
claim); the completion fan-out resolves the **holder's own** workflow IR and never a project-wide
terminal-column union; and a settlement transition cannot overwrite a successor or terminal graph
transition — only the dishonest fake ever "allowed" that.

## The collateral that the same sweep exposed

The same drift class was found in files that are owners of this seam rather than the reported symptoms,
each base-proven red and each repaired to the live contract with strictly stronger assertions:

- `agent-heartbeat-overlap-wait.test.ts` still asserted the heartbeat's inline `resolvePendingOverlapWaits`
  claim, which `FNXC:MergeRebuild0919 2026-09-19-21:45` deliberately dropped in favour of the
  acquisition-owned `overlapResumeDelivery`. The dropped second claimant is now pinned: the heartbeat must
  never call `claimTaskOverlapWait` itself.
- `self-healing-overlap-release-wake.test.ts` left `groupOverlappingFiles` unset, and production reads that
  absence as "feature off ⇒ any surviving `overlapBlockedBy` is stale by definition" — so its "still active
  holder is preserved" case proved the opposite of its name. Declaring the flag makes all five cases
  exercise the real lifetime decision.
- `self-healing-overlap-evidence-guard.test.ts` kept a blanket `expect(updateTask).not.toHaveBeenCalled()`
  after RUFU-231 (`913d6076a4`) made a counted branch-conflict rejection consume a bounded recovery
  attempt; it now asserts the one budget write exactly and forbids the `worktree`/`branch`/`baseCommitSha`
  clear it actually cares about.
- `overlap-resume-production-chain.test.ts` died inside the finalizer —
  `required post-merge evidence gate 'post-merge-verification' has not reported
  [post-merge gate unreachable: unsupported-store]`, then `TypeError: store.moveTaskIf is not a function`.
  Production is right on both counts (a direct AI merge must not report success while a required gate can
  never report, and finalization's terminal move is the fenced `moveTaskIf`, not the public `moveTask`), so
  the fixture declares the optional-group answer (`enabledWorkflowSteps: []`, the same vocabulary
  `confirmed-merge-must-finalize.test.ts` uses) and implements `moveTaskIf` as a **real** move that emits
  `task:moved`, because the fan-out under test is driven by that event. The publish-before-terminal-move
  assertion moved to the seam that actually moves and additionally pins that the unguarded `moveTask` is
  never called.
- One real production defect: `dispatchPlanningContinuationIfCurrent` lost its `export` keyword in a merge
  resolution while the file's own closing note still documented it as one of three exported
  planning-continuation seams — a lost-seam regression, not an intentional narrowing.

## The emptiness-proof call-site map

`proveDormantCheckoutEmptiness` has six production call sites: `scheduler.ts` (the dormant-lease pass),
`self-healing.ts` (two lease decisions), `executor/file-scope-lease-dispatch-gate.ts`,
`healing/gridlock-detector.ts`, and `concurrency/concurrency.ts` (worktree capacity holders). **None of
them passes a `prover`** — verified by grepping `prover:` across `packages/*/src` outside `__tests__`,
which returns nothing — so every one of them relies on `checkoutEmptinessProverFor(rootDir)` and its
**process-global, per-rootDir** prover cache.

That has two consequences a unit fixture cannot ignore:

1. With no injected prover, the answer comes from real `git` subprocesses. A scheduling fixture whose
   card paths do not exist (`/wt/a`, `/repo`, `/tmp/project`) pays subprocess cost only to receive
   `unknown` from ENOENT — green by the *absence* of proof rather than by a verdict the case chose, and
   a slow test by the repo's own rule.
2. The cache is keyed by the `rootDir` **string**, which different engine test files reuse, so verdicts
   leak across cases unless `resetCheckoutEmptinessProversForTesting()` runs around each one.

The seam chosen for the starvation fixture is a `vi.mock` of `../worktree/checkout-emptiness.js` that
answers from a per-case `checkoutProofs` map — empty by default, which is the same fail-closed answer the
failing probes produced, so no existing case changes meaning — with `resetCheckoutEmptinessProversForTesting()`
in both `beforeEach` and `afterEach`, and a recorded `proofRequests` list pinning that
`Scheduler.schedule()` asks about exactly the would-be-dormant cards. Real `git` stays owned by
`checkout-emptiness.real-git.test.ts`; proof-map semantics stay in
`scheduler-overlap-lease-until-done.test.ts`.

## Rules that keep this from coming back

- **No collect-only CAS fakes.** A fake `transitionWorkflowWorkItem` must own mutable rows, enforce
  `expectedState` / `expectedLeaseOwner` by returning the untouched live row on mismatch, apply every
  non-fence patch field, and return the post-transition row including `leaseOwner`.
- **A fake must gain the seam production calls, not the assertion.** `store.moveTaskIf`, a
  `leaseOwner`-bearing return row, and an honest `getSettings` are production requirements, not test
  preferences; when the terminal move moves seams, move the assertion *and* name the change in a comment.
- **State the emptiness verdict per case; never inherit it.** Declare the proof map (or point the fake's
  `getRootDir()` at a real throwaway repository built in `beforeEach`), and reset the prover cache on both
  sides of every case.
- **No real `git` in scheduling unit tests.** If a fixture file's duration is dominated by subprocess
  spawns, that is the bug, not the cost of the test.
- **Never buy precedence with a deleted field.** A key that no type reads any more survives only through a
  cast and silently ties on the surviving ordering input; if a case depends on queue order, make the
  arrival timestamps say so and prove it with an inverted-order negative control.
- **Measure the pg layer first** when unit and pg disagree, and record the verdict (harness vs product)
  with the first thrown error and stack — not the failure count.

## Verification that resolved it

```bash
# the three symptom files, green by name
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/file-scope-continuation-wait.test.ts \
  src/__tests__/self-healing-completion-fanout.test.ts \
  src/__tests__/scheduler-overlap-starvation.test.ts \
  --silent=passed-only --reporter=dot          # 3 files, 86 passed, 0 failed, 0 skipped

# pg ground truth of the same seam (needs CI-shape credentials, not just a listening port)
FUSION_PG_TEST_URL_BASE=postgresql://postgres:postgres@127.0.0.1:5435 \
  pnpm --filter @fusion/core exec vitest run \
  src/__tests__/postgres/overlap-wait-release.pg.test.ts \
  src/__tests__/postgres/overlap-wait-persistence.pg.test.ts \
  src/__tests__/postgres/queued-episode-transition.pg.test.ts \
  src/__tests__/workflow-work-item-cas.test.ts   # 4 files, 64 passed, exit 0
```

Post-run state: 8 / 23 / 55 passing in the three symptom files respectively, and the starvation file's
wall time is 6.7 s with 335 ms of test time and no `child_process` import — proof the fixture no longer
shells out.
