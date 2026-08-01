# Closing-bar verification — workflow-owned lifecycle

The programme's closing bar requires one verification pass on one tree: gate,
`verify:fast`, the live E2E families, and the census. This file is the runbook and the
record, so the pass is reproducible rather than re-derived each time.

## How to run it

```bash
git checkout --detach origin/main            # one tree, no local commits
pnpm test:gate
pnpm verify:fast
# GLOB the E2E families — do not hard-code a count (see "Findings" below)
pnpm --filter @fusion/engine exec vitest run \
  $(cd packages/engine && ls src/__tests__/*live-e2e*.test.ts | tr '\n' ' ') --reporter=dot
node scripts/lifecycle-column-census.mjs
```

## Recorded passes

### 2026-07-30, `origin/main` @ `a6138abeff` (latest)

| Check | Result |
|---|---|
| `pnpm test:gate` | PASS |
| E2E families | **14 files / 112 tests PASS**, exit 0 |
| census | COLUMN 748 · ROLE 5 · STATUS 186 · DELIBERATE-LITERAL 17 · QUERY 83 · IR-node 43 |

### 2026-07-30, `origin/main` @ `be63e72f1` (first pass)

| Check | Result |
|---|---|
| `pnpm test:gate` | PASS — 132 + 10 + 487 + 71 tests |
| `pnpm verify:fast` | PASS — 13 steps in 89.9s; boot smoke `GET /api/health 200`, clean shutdown |
| E2E families | 13 files / 109 tests — 2 failed until the planning-lane seed fix (#2658) |
| census | COLUMN 787 · ROLE 0 · STATUS 182 · DELIBERATE-LITERAL 3 · triage 10 |

**Both numbers moved within a few hours**, which is the point of recording the commit
alongside the result: a bare count in an instruction is stale by the time it is read. The
family count went 13 → 14 and the backlog 787 → 748 between these two passes, and the
census grew two categories (`QUERY filters`, `IR node definitions`) that did not exist in
the first run.

## Findings

### 1. Glob the E2E families; never count them

The bar said "all-8 E2E". There were **13** at the time of this pass:

```
agent-count · agent-link · lease-rebound · lifecycle · merge-family · merge-rebound
merge-safeguards · merged-board · planner-lane · planner-lane-resolution
planning-lane · rebound-family · stranded-column
```

A pass scoped to eight would have skipped five — **including the only one that was red**.
The suite grows as evidence lands, so the count in any instruction is stale on arrival.
The command above globs for this reason.

### 2. A release-path E2E fails when its fixture never wrote a spec

Symptom: `runHoldReleaseSweep(...).released` comes back EMPTY, often for the suite's own
control card.

Cause: task creation leaves a bootstrap-seed `PROMPT.md` (`# <id>\n\n<description>`), and
FN-7648's `isUnplannedForExecution` reads that file for any card resting in an `intake`-
or `hold`-trait column and refuses to move an unplanned card into a processing column.
**The sweep is correct; the fixture is asking it to release a card that was never
specified.**

This has now occurred **twice** in independently written suites —
`workflow-lifecycle-live-e2e` (fixed in #2634) and `workflow-planning-lane-live-e2e`
(fixed in #2658, and independently by a second worker, wasting the duplicate effort). The
graph-entry contract doc already states the rule:

> Scheduler/release test fixtures must model a card that cleared the gate ... A held
> unreviewed card is the gate working.

**Any new suite that drives the release sweep must seed a planned `PROMPT.md`.** A shared
`seedPlannedTask` helper in `_workflow-vocabulary-fixture.ts` would end the pattern; it
was not added while several consolidation branches still touch those files.

Diagnostic order that identifies this quickly, and two hypotheses it kills:

1. `sweep()` returns `held: [{ reason: "move-rejected-or-no-slot" }]`.
2. Adding `maxConcurrent`/`maxWorktrees` to the settings changes nothing — **not** the
   in-transaction capacity gate.
3. A direct `store.moveTask(id, wip)` **succeeds** — the move is not the blocker.
4. `isTaskBlockedOnApproval` is false, `isUnplannedForExecution` is **true**.
5. Read the seeded `PROMPT.md`: it is the stub.

### 3. `DELIBERATE-LITERAL` is internally consistent

`deliberate: 3` reconciles exactly: `hold-release.ts` 2 + `live-agent-count.ts` 1.
`replan-target.ts` carries two markers above `return "triage"` **return-value** literals,
which the census correctly does not count as guards at all — so they appear in neither
`deliberate` nor `column`. A lower number than a previously quoted one is not evidence of
lost markers; check `--json byFile` before treating it as a gap.

`hasDeliberateMarker` walks every **ancestor**, not the enclosing statement, because real
markers sit above the enclosing function while the comparison is a `return` inside it. A
statement-only lookup silently reclassified three reviewed literals as backlog.
