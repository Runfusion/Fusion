---
category: test-failures
module: testing
date: 2026-09-25
problem_type: loaded_vitest_regression_population
component: full-suite-census
severity: high
applies_when:
  - "The non-blocking Full Suite lane on main is red and the failing suites are still unnamed"
  - "Deciding whether a red full-suite run is a flake or a regression"
  - "Triage needs a per-case, per-family inventory rather than a red/green verdict"
tags:
  - census
  - vitest
  - full-suite
  - ci
  - regression-triage
  - fn-2020
---

# FUSI-020 — main Full Suite failure census and dispositions

Observed 2026-09-25 (UTC) against `Runfusion/Fusion` `main`.

## Authoritative run

| field | value |
|---|---|
| workflow | `full-suite.yml` (Full Suite (non-blocking)) |
| run | **#3158** (`36102810042`) |
| head_sha | `b37d0fe26b4faab376b8a60f3d0c3866cf8b0b7f` |
| created_at | `2026-09-25T06:25:42Z` |
| conclusion | `failure` |
| previous run | #3157 (`36099164485`, `bade425e74...`, `2026-09-25T05:34:58Z`, `failure`) |
| last green main push run | **#1396**, `2026-07-26T04:14:37Z` |

The lane has been red on **every** main push since #1396 — **1762 consecutive
red runs**, API-verified:

```
WF='repos/Runfusion/Fusion/actions/workflows/full-suite.yml/runs?branch=main&created=>2026-07-26T04:14:37Z&per_page=1'
gh api "$WF" --jq .total_count                        # 1762
gh api "$WF&status=success" --jq .total_count         # 0
gh api "$WF&status=failure" --jq .total_count         # 1762
```

#1396 is the last green (`2026-07-26T04:14:37Z`), so the red streak is runs
#1397-#3158 inclusive = 1762, with zero successes, cancellations or skips in
between. The original intake window (2026-09-23 02:01Z-04:38Z, 6 runs) is a
subset of this unbroken red period; the failing job set is unchanged:
`Test shard 1/4`-`4/4` plus `Pipeline smoke tier`.

## Census — 233 named failing cases across 117 files

Extracted from the #3158 job logs: every `FAIL <project> <file> > <suite > case>`
line, paired with its following error line, then de-duplicated on
`(shard, file, case, error)`.

| job | `FAIL` lines | named cases | distinct files |
|---|---|---|---|
| `Test shard 1/4` (`@fusion/engine` 1/2) | 111 | 110 | 54 |
| `Test shard 2/4` (`@fusion/engine` 2/2) | 107 | 107 | 49 |
| `Test shard 3/4` (`@runfusion/fusion` CLI) | 4 | 4 | 4 |
| `Test shard 4/4` (`@fusion/core` 2/2) | 12 | 12 | 10 |
| **total** | **234** | **233** | **117** |

Shard 1 prints 111 `FAIL` lines for 110 distinct cases: vitest re-emits
`cleanupLandedTaskWorktree > finalizes a durable landing when cleanup preserves
content` twice, so the raw line count over-reports that file by one. The 234
figure is the count of `FAIL` lines; 233 is the count of named cases, and the
per-case table below carries 233 rows.

The per-shard `Tests ... failed` summaries in the same logs read 111 / 107 / 4 /
12 = 234, so vitest itself counted the duplicated row; the discrepancy is in the
reporter, not in the case inventory. #3157 produces the same case set — these are
deterministic, not load-dependent flakes.

`Pipeline smoke tier` fails separately: the watchdog kills the
`engine-pipeline-smoke` project at its 175 000 ms budget
(`HANG: pipeline smoke exceeded budget 175000ms (elapsed 175006ms)`). The
PostgreSQL service log in the same job shows
`FATAL: password authentication failed for user "runner"` /
`Role "runner" does not exist`.

**That log is a lead, not an established cause.** The job provisions the service
with `POSTGRES_USER=postgres` and exports a `postgres`-role connection URL via
`FUSION_PG_TEST_URL_BASE` plus `PGPASSWORD` (see
`.github/workflows/full-suite.yml`), so the *configured* smoke harness connects
as `postgres`. Nothing in the evidence shows the `runner`
authentication attempt came from that harness rather than from a child process
that ignored the provisioned URL, and the job-level timeout is a 175 000 ms
watchdog on the pipeline project — not proof that a connection attempt caused
the hang. FUSI-037 owns establishing the cause; this census records only the
two observed facts (watchdog budget exceeded, `runner` auth errors present in
the same job's service log) and does not attribute the hang to role
misconfiguration.

## Classification: 0 flakes; 17 verified here, 201 grouped by error line, 15 unresolved

Checked **before** treating anything as a regression:

- `scripts/lib/test-quarantine.json` on `main` holds exactly one entry —
  `packages/desktop/src/__tests__/native.test.ts` (quarantined 2026-09-24,
  second-sighting rule). The ledger is **not** empty. That file is **not** among
  the 117 census files, so no census case is already quarantined; the
  conclusion rests on the file being absent from the inventory below, not on an
  empty ledger.
- `docs/solutions/test-failures/suite-only-flakes-observed-register.md` -> the
  only census file it mentions is `src/__tests__/plugin-runner.test.ts`, and that
  record (**entry 3**) is **Closed 2026-08-17 by FN-9141 — rescued (fixture
  defect)**; its ledger row and exclude were removed. It is not an active flake.
- Per the AGENTS.md gate rule, a merge-gate flake would be evicted from the
  `engine-core` allow-list rather than quarantined. No census case is in that
  allow-list, so no eviction applies.

Verdict: **no first-sighting flake record and no quarantine entry is warranted.**
Of the 233 named cases, **17 have a verified cause** — each was reproduced, its
cause traced to one of the three product changes below, and fixed in this task.
A further **201 carry a real, reproducible failure with a supported error class
but an unverified cause**: the shard log names the first error line, which
establishes *that* the case fails and roughly *how*, not *why*. They are grouped,
not confirmed, and each is routed to the follow-up that must reproduce it and
establish the cause. The remaining **15 cases (`assertion-no-error-line`) are
unresolved**: the shard log truncated their error text, so a matching case set
across two runs and the ledger check above cannot classify them either way.
FUSI-034 reproduces each and captures the real error; no cause is asserted for
them here.

So this census reports **0 confirmed flakes, 17 confirmed regressions fixed
here, and 201 grouped cases with unverified causes out of 233 named cases**, with
15 pending. "0 flakes" means nothing in this census has been *shown* to be a
flake on the evidence available — it is not a claim that a flake is impossible
among the 201 grouped or 15 unresolved cases.

**A group is not a diagnosis.** Families are keyed mechanically on the first
error line, so a family label describes a symptom, not a root cause. The clearest
example is `runtime-Error` (7 cases, FUSI-035): it pools a 30-second test
timeout (`post-done-continuation-no-wedge.test.ts`), a missing source file
(`ENOENT … packages/cli/src/commands/research.ts`) and a 5-second timeout
(`skills-get.test.ts`). None of those establishes that a test asserts an old
call contract or that a harness double is stale — the definition of a regression
used in the fixed-here table. They are reproducible failures, so they are real
work, but their causes are unknown until FUSI-035 reproduces each one. Treat
every grouped case as **"fails, cause open"** rather than "regression", and let
the follow-up card earn the diagnosis.

## Families (grouped; 11 families over 233 named cases)

Every row is derived mechanically from the per-case table below, keyed on the
first error line: `to be called with arguments` splits on the literal argument
shape (`'done'` / `'Bash'` / other), a leading `TypeError:` that names a missing
collaborator splits off the four harness families, `TransitionRejectionError`
is its own family, a `Error:`-prefixed line is runtime, and everything else is
`assertion-other`. Counts sum to 233. **A family is a symptom grouping, not a
diagnosis** — only the `fixed here` column has a verified cause, because only
those cases were reproduced and traced (see "A group is not a diagnosis" above).

| family | cases | files | fixed here | disposition |
|---|---|---|---|---|
| `assertion-other` (value/deep-equal/object-match drift) | 136 | 83 | 0 | cause open — FUSI-031 |
| `missing-mock-call-other` (mock never reached) | 45 | 25 | 0 | cause open — FUSI-032 |
| `assertion-no-error-line` (error text truncated in shard log) | 15 | 6 | 0 | **not yet classified** — FUSI-034 |
| `moveTask-workflowMoveSource-arg` | 10 | 4 | 10 | **fixed in this task** |
| `harness-product-drift-TypeError` | 7 | 6 | 1 | cause open — FUSI-033 (1 case fixed here) |
| `runtime-Error` (timeout / ENOENT / non-zero exit) | 7 | 7 | 0 | cause open — FUSI-035 |
| `store-double-missing-getTask` | 5 | 3 | 0 | cause open — FUSI-030 |
| `harness-missing-resolveMergeGateBlocker` | 3 | 2 | 3 | **fixed in this task** |
| `lifecycle-transition-forbidden` (FN-217 F2 rank rules) | 2 | 2 | 0 | cause open — FUSI-036 |
| `appendAgentLog-tool-detail-arg` | 2 | 2 | 2 | **fixed in this task** |
| `canMergeTask-reviewColumns-signature` | 1 | 1 | 1 | **fixed in this task** |
| **total** | **233** | **117** | **17** | |

Two corrections against the first pass of this table, both re-derived from the
shard logs rather than adjusted to taste:

- The `moveTask` family is **10 cases / 4 files**, not 11 / 5. The eleventh
  `'done'`-shaped row, `ce-workflow-step-executor.test.ts` case *finalizes a
  merge-confirmed workflow graph task that is stranded before done*, is a
  **zero-calls** failure: the log's `Number of calls: 0` line shows `moveTask`
  was never invoked, so no argument shape is at fault and the case belongs to
  `missing-mock-call-other`. That file is not in this task's File Scope and its
  case stays with FUSI-032.
- `harness-product-drift-TypeError` is **7 cases / 6 files**, one of which this
  task fixed. The `store.logEntry is not a function` row in
  `project-engine-merge-lane-resolved.test.ts` is that case: the drain-dequeue
  fake lacked both `resolveMergeGateBlocker` and a `logEntry` collaborator, so
  the loop threw on whichever it reached first. Adding the `resolveMergeGateBlocker`
  double short-circuits `canMergeTask` before the `logEntry` call, so both the
  recorded TypeError and its sibling are resolved by the same edit. The family
  split still follows the literal error text, not the fix.

The `assertion-no-error-line` family is deliberately **not** dispositioned here:
those 15 cases have no error text in the shard log, so naming a cause would be a
guess. FUSI-034 exists to reproduce each one and capture the real error.

### The three product changes behind every fixed case

1. **`moveTask` gained a third `{ workflowMoveSource }` audit argument.**
   `packages/core/src/task-store/moves.ts` and the engine's move call sites now
   stamp provenance on lifecycle moves; the old two-argument
   `toHaveBeenCalledWith(id, "done")` assertions no longer match.
2. **`appendAgentLog`'s 4th argument (tool argument summary) is now populated**
   for every Bash call, so the `undefined` placeholder in the old assertion is
   gone.
3. **`canMergeTask`'s third positional parameter changed** from
   `isReviewColumn?: boolean` to `reviewColumns?: ReadonlySet<string>`
   (`packages/engine/src/project-engine.ts:2847`), and
   `enqueueEligibleInReviewTasks` now calls the
   `this.resolveMergeGateBlocker(...)` collaborator
   (`packages/engine/src/project-engine.ts:3238`).

Per AGENTS.md **"A Behavior Change Owns Every Test That Asserts the Old
Behavior"**, the assertions were updated to the new contract — no timeout was
widened, no retry added, no assertion loosened, and nothing was skipped.

## Fixed in this task (6 files, 17 named cases, in File Scope)

| file | cases addressed |
|---|---|
| `packages/engine/src/__tests__/project-engine-auto-heal-lane-resolved.test.ts` | 3 (`reviewColumns` signature + two `resolveMergeGateBlocker` collaborator cases) |
| `packages/engine/src/__tests__/project-engine-merge-lane-resolved.test.ts` | 2 (`resolveMergeGateBlocker` collaborator in the sweep and in the final dequeue) |
| `packages/engine/src/__tests__/merger-merge-details.test.ts` | 2 (`appendAgentLog` detail arg, `moveTask` provenance arg) |
| `packages/engine/src/__tests__/merger-skills.test.ts` | 1 (`moveTask` provenance arg) |
| `packages/engine/src/__tests__/merger-verification.test.ts` | 7 (6 `moveTask` provenance args, 1 `appendAgentLog` detail arg) |
| `packages/engine/src/__tests__/merger-finalize-unproven.real-git.test.ts` | 2 (`moveTask` provenance arg) |
| **total** | **17** |

Six files are changed, not five: `project-engine-merge-lane-resolved.test.ts`
carries two of the named failures (`TypeError: this.resolveMergeGateBlocker is
not a function` in the periodic sweep, and `TypeError: store.logEntry is not a
function` in the final dequeue) and was fixed in the same commit. The per-family
`fixed here` column above is the authority; this table is its per-file expansion.

## After-green verification (the "after" half of Symptom Verification)

Step 7 asks for the post-disposition command output, not just the census. Re-run
file-scoped over exactly the 6 changed suites, on this branch's tree
(`e470d5c64` + this commit), with the same invocation shape the shards use:

```
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/merger-finalize-unproven.real-git.test.ts \
  src/__tests__/merger-merge-details.test.ts \
  src/__tests__/merger-skills.test.ts \
  src/__tests__/merger-verification.test.ts \
  src/__tests__/project-engine-auto-heal-lane-resolved.test.ts \
  src/__tests__/project-engine-merge-lane-resolved.test.ts \
  --silent=passed-only --reporter=dot
```

```
 Test Files  6 passed (6)
      Tests  157 passed (157)
   Duration  184.80s
```

Exit code 0. All 17 named cases in those 6 files are green; nothing was
quarantined, skipped, retried or timed out, so the 157 includes the previously
failing assertions rather than a reduced count. Two pre-existing
`vi.mock` hoisting **warnings** are emitted by `merger-skills.test.ts` and are
unrelated to these cases (they concern a nested
`../cli-runtime/session-skill-context.js` specifier, not an assertion).

**Before/after pairing.** The "before" is the #3158 shard log itself: the 17
`FAIL` lines for these 6 files are reproduced verbatim in the per-case table
above, each with its recorded error. The "after" is the 6-passed/157-passed
run above. Per-file, the 17 addresses are exactly: 3 + 2 + 2 + 1 + 7 + 2.

**What this does not prove.** 216 of the 233 named cases live in files outside
this task's File Scope and are carried by FUSI-030…037, so the Full Suite lane
stays red on main until those land. The next main push run turning green is the
operator-visible confirmation and cannot be produced by this branch alone.

## Remaining follow-ups (out of this task's scope)

`assertion-other`, `missing-mock-call-other`, `harness-product-drift-TypeError`,
`runtime-Error`, `store-double-missing-getTask` and
`lifecycle-transition-forbidden` each pool cases this task's File Scope does not
cover. They are carried by the follow-up cards named in the family table, and
each card's first job is to **establish the cause its family only groups** — the
family label is a symptom, so a follow-up must not inherit it as a diagnosis.
`assertion-no-error-line` is not even a symptom class: those 15 cases have no
error text in the log, so FUSI-034 owns reproducing them and capturing the real
error before anything is dispositioned.

| follow-up | family |
|---|---|
| FUSI-030 | `store-double-missing-getTask` |
| FUSI-031 | `assertion-other` |
| FUSI-032 | `missing-mock-call-other` |
| FUSI-033 | `harness-product-drift-TypeError` |
| FUSI-034 | `assertion-no-error-line` (classify, do not assume) |
| FUSI-035 | `runtime-Error` (timeouts and a missing source file, not one drift) |
| FUSI-036 | `lifecycle-transition-forbidden` |
| FUSI-037 | `Pipeline smoke tier` watchdog hang (cause unproven — see above) |

216 of the 233 named cases sit in those eight cards (15 of them the
`assertion-no-error-line` family, which FUSI-034 must classify rather than
assume); 17 are fixed here. **None of the 216 has a verified cause** — they are
reproducible failures whose cause this census did not establish, so each
follow-up earns its own diagnosis rather than inheriting the family label.

## Full per-case census (#3158)

Every failing `file -> suite > case` with its first error line, as logged — 233
rows, one per named case, de-duplicated. Where the log's own detail line changes
the reading of the first error line (for example a `Number of calls: 0` line
that reclassifies a case), that detail is quoted inline and the family is named
there.

| shard | file | suite > case | first error line |
|---|---|---|---|
| `Test shard 1/4` | `src/__tests__/auto-recovery-contamination.test.ts` | ContaminationAutoRecoveryHandler > requeues and clears paused state | TypeError: store.getTask is not a function |
| `Test shard 1/4` | `src/__tests__/ce-workflow-step-executor.test.ts` | CE workflow-step executor integration > runGraphCustomNode skill node (U1/U2) > blocks the merge requester when graph traversal reaches merge before implementation steps finish | AssertionError: expected { outcome: 'failure', …(2) } to deeply equal ObjectContaining{…} |
| `Test shard 1/4` | `src/__tests__/ce-workflow-step-executor.test.ts` | CE workflow-step executor integration > runGraphCustomNode skill node (U1/U2) > finalizes a merge-confirmed workflow graph task that is stranded before done | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-CE-1', 'done', …(1) ] — followed by `Number of calls: 0`, so `moveTask` was never invoked (family `missing-mock-call-other`, not the provenance-arg shape) |
| `Test shard 1/4` | `src/__tests__/ce-workflow-step-executor.test.ts` | CE workflow-step executor integration > runGraphCustomNode skill node (U1/U2) > lets the graph prepare a task worktree before the first CE coding-mode node runs | AssertionError: expected 'failure' to be 'success' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/ce-workflow-step-executor.test.ts` | CE workflow-step executor integration > runGraphCustomNode skill node (U1/U2) > prepares an inline-fix Code Review node when it acquires an absent worktree | AssertionError: expected "createWorktree" to be called 1 times, but got 0 times |
| `Test shard 1/4` | `src/__tests__/ce-workflow-step-executor.test.ts` | CE workflow-step executor integration > runGraphCustomNode skill node (U1/U2) > prepares an inline-fix Code Review node when it reacquires a stale worktree | AssertionError: expected "createWorktree" to be called 1 times, but got 0 times |
| `Test shard 1/4` | `src/__tests__/ce-workflow-step-executor.test.ts` | CE workflow-step executor integration > runGraphCustomNode skill node (U1/U2) > reacquires a task worktree when a CE graph node finds a stale missing checkout | AssertionError: expected 'failure' to be 'success' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/custom-providers-openai-completions.test.ts` | custom providers openai-completions regression > emits developer role when compat allows it on reasoning models | AssertionError: expected undefined to be 'developer' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/custom-providers-openai-completions.test.ts` | custom providers openai-completions regression > uses system role when reasoning model explicitly disables developer role compat | AssertionError: expected undefined to be 'system' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/executor-graph-failure-lanes-resolved.test.ts` | the execution-resume router's gate reads the same board as its destination > admits a HOLD-lane card that still has unfinished steps | AssertionError: expected false to be true // Object.is equality |
| `Test shard 1/4` | `src/__tests__/executor-graph-failure-lanes-resolved.test.ts` | the execution-resume router's gate reads the same board as its destination > admits a review-lane card | AssertionError: expected false to be true // Object.is equality |
| `Test shard 1/4` | `src/__tests__/executor-lifecycle-ownership-ledger.test.ts` | U8 execution-lifecycle ownership ledger > handleGraphFailure: executor-owned dispositions match the ledger | AssertionError: expected { …(3) } to deeply equal { …(3) } |
| `Test shard 1/4` | `src/__tests__/executor-lifecycle-ownership-ledger.test.ts` | U8 execution-lifecycle ownership ledger > runImplementation: executor-owned dispositions match the ledger | AssertionError: expected { …(4) } to deeply equal { …(4) } |
| `Test shard 1/4` | `src/__tests__/executor-live-branch-group-auto-merge-hold.test.ts` | executor shared-branch autoMerge:false liveness gates > FN-8910 replans Plan Review for an unset project-Off shared member | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-1980', 'todo', { …(2) } ] |
| `Test shard 1/4` | `src/__tests__/executor-live-overseer-retry-gate.test.ts` | handleGraphFailure execute-family live session preserve > still parks status=failed for merge-region failure even when a live session exists | AssertionError: expected "vi.fn()" to be called with arguments: [ Array(3) ] |
| `Test shard 1/4` | `src/__tests__/executor-paused-abort-todo-benign.test.ts` | pause-abort benign requeue-to-todo (FN-6782) > does not transiently retry partial progress with 'durable failureReason' | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-6782-T', …(2) ] |
| `Test shard 1/4` | `src/__tests__/executor-paused-abort-todo-benign.test.ts` | pause-abort benign requeue-to-todo (FN-6782) > does not transiently retry partial progress with 'durable lastError' | (no error line in shard log) |
| `Test shard 1/4` | `src/__tests__/executor-paused-abort-todo-benign.test.ts` | pause-abort benign requeue-to-todo (FN-6782) > does not transiently retry partial progress with 'exhausted retry budget' | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-6782-T', …(2) ] |
| `Test shard 1/4` | `src/__tests__/executor-paused-abort-todo-benign.test.ts` | pause-abort benign requeue-to-todo (FN-6782) > does not transiently retry partial progress with 'explicit graph reason' | (no error line in shard log) |
| `Test shard 1/4` | `src/__tests__/executor-paused-abort-todo-benign.test.ts` | pause-abort benign requeue-to-todo (FN-6782) > does not transiently retry partial progress with 'fully terminal steps' | (no error line in shard log) |
| `Test shard 1/4` | `src/__tests__/executor-primitive-exit-events.test.ts` | compat park for graphs that do not route review-pending > does NOT park for an ordinary failure with no pending-review value anywhere | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-COMPAT', …(2) ] |
| `Test shard 1/4` | `src/__tests__/executor-primitive-exit-events.test.ts` | compat park for graphs that do not route review-pending > does NOT park when a LATER node reported its own failure (stale value must not mask it) | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-COMPAT', …(2) ] |
| `Test shard 1/4` | `src/__tests__/executor-step-numbering-zero-based.test.ts` | executor tool step numbering is 0-based > pending-review loop detection matches 0-based writer strings | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-6607-P', …(3) ] |
| `Test shard 1/4` | `src/__tests__/executor-step-session.test.ts` | Workflow Steps Execution > clears a stale assistant-continuation resume session and requeues without marking the task failed | AssertionError: Target cannot be null or undefined. |
| `Test shard 1/4` | `src/__tests__/executor-step-session.test.ts` | Workflow Steps Execution > fails a repeated stale assistant-continuation after the fresh-session retry budget is exhausted | AssertionError: Target cannot be null or undefined. |
| `Test shard 1/4` | `src/__tests__/graph-node-workspace-boundary.test.ts` | graph node workspace session boundary > keeps Plan Review on its deliberate shared-root boundary | AssertionError: expected { kind: 'workspace-task-dir', …(3) } to be undefined |
| `Test shard 1/4` | `src/__tests__/in-review-unmet-dependency-reconcile.test.ts` | executor dependency dispatch gate > blocks workflow graph and authoritative dispatch before unmet dependencies can advance | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-DISPATCH', 'todo', …(1) ] |
| `Test shard 1/4` | `src/__tests__/in-review-unmet-dependency-reconcile.test.ts` | in-review unmet dependency reconciliation > reproduces FN-6778/FN-6779 review advancement and rebounds to queued todo | AssertionError: expected { id: 'FN-6778', …(11) } to match object { column: 'todo', …(2) } |
| `Test shard 1/4` | `src/__tests__/log-severity-spam-contract.test.ts` | log severity spam contract (source) > keeps every manifest entry at its audited severity | AssertionError: cli-runtime/pty-native.ts: Pre-loaded native module via dlopen: expected [] to have a length of 1 but got +0 |
| `Test shard 1/4` | `src/__tests__/log-severity-spam-contract.test.ts` | log severity spam contract (source) > routes production diagnostics through createLogger | AssertionError: /home/runner/work/Fusion/Fusion/packages/engine/src/cloud-link-presence.ts: expected '\nimport { execFile } from "node:chil…' not to match /console\.(log\|warn\|error |
| `Test shard 1/4` | `src/__tests__/log-severity-spam-contract.test.ts` | log severity spam contract (source) > self-healing no-action/skip, worktree-pool probes, and ntfy bookkeeping use debug | AssertionError: expected 'import { exec, execFile } from "node:…' to match /worktreePoolLog\.debug\(`Rehydrate sk…/ |
| `Test shard 1/4` | `src/__tests__/merger-finalize-unproven.real-git.test.ts` | aiMergeTask finalize no-op unproven reproduction (real git) > FN-6461: allows all-done no-commits empty-own-diff fast-path tasks | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-EMPTY-DONE', 'done' ] |
| `Test shard 1/4` | `src/__tests__/merger-finalize-unproven.real-git.test.ts` | aiMergeTask finalize no-op unproven reproduction (real git) > FN-6461: allows all-done no-commits proven no-op tasks to finalize | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-NO-COMMITS-DONE', 'done' ] |
| `Test shard 1/4` | `src/__tests__/merger-integration-worktree.test.ts` | acquireReuseHandoff > surfaces pool double-lease failures with structured diagnostics | AssertionError: expected TypeError: __vite_ssr_import_7__.PoolDoub… to be an instance of MergeHandoffRefusedError |
| `Test shard 1/4` | `src/__tests__/merger-merge-details.test.ts` | aiMergeTask — agent log persistence > logs tool invocations to store.appendAgentLog | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'Bash', 'tool', …(2) ] |
| `Test shard 1/4` | `src/__tests__/merger-merge-details.test.ts` | aiMergeTask — merge details collection > completes merge even when git commands fail during merge details collection | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'done' ] |
| `Test shard 1/4` | `src/__tests__/merger-skills.test.ts` | aiMergeTask — skill selection non-fatal diagnostics (FN-1510/FN-1511) > merge continues when skill selection produces diagnostics | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'done' ] |
| `Test shard 1/4` | `src/__tests__/merger-verification.test.ts` | aiMergeTask — build verification > merge proceeds normally when no build command is configured | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'done' ] |
| `Test shard 1/4` | `src/__tests__/merger-verification.test.ts` | aiMergeTask — build verification > merge proceeds when buildCommand is empty string (treated as undefined) | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'done' ] |
| `Test shard 1/4` | `src/__tests__/merger-verification.test.ts` | aiMergeTask — build verification > merge succeeds when build passes (agent reports success) | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'done' ] |
| `Test shard 1/4` | `src/__tests__/merger-verification.test.ts` | aiMergeTask — deterministic merge verification > does not fail verification when verbose test output exceeds buffer after exit 0 | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'done' ] |
| `Test shard 1/4` | `src/__tests__/merger-verification.test.ts` | aiMergeTask — in-merge verification fix > logs fix-agent startup metadata, streams callbacks, and logs rerun lifecycle | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'Bash', 'tool', …(2) ] |
| `Test shard 1/4` | `src/__tests__/merger-verification.test.ts` | aiMergeTask — inferred test command execution > runs inferred test command when settings.testCommand is not configured | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'done' ] |
| `Test shard 1/4` | `src/__tests__/merger-verification.test.ts` | aiMergeTask — inferred test command execution > skips verification when no lock files exist and no explicit testCommand is set | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-050', 'done' ] |
| `Test shard 1/4` | `src/__tests__/node-worktree-isolation.test.ts` | every workflow node runs in the task worktree, never the shared checkout > acquires a task worktree for Plan Review when the task has none | AssertionError: expected '/tmp/test/.fusion/worktrees/fn-1403' to contain '/tmp/test/.worktrees/' |
| `Test shard 1/4` | `src/__tests__/node-worktree-isolation.test.ts` | every workflow node runs in the task worktree, never the shared checkout > acquires a task worktree for a custom read-only gate when the task has none | AssertionError: expected '/tmp/test/.fusion/worktrees/fn-1403' to contain '/tmp/test/.worktrees/' |
| `Test shard 1/4` | `src/__tests__/pi-anthropic-claude-code-identity.test.ts` | attachAnthropicClaudeCodeIdentityHeaders > overrides pi-ai's stale OAuth identity and meets every declared model minimum | AssertionError: expected 0 to be greater than 0 |
| `Test shard 1/4` | `src/__tests__/plan-prompt-write-surfaces.test.ts` | planning prompt-write surfaces > never treats a promptless updateTask row as verification evidence | AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times |
| `Test shard 1/4` | `src/__tests__/planner-overseer-intervention-wiring.test.ts` | FN-7551 — overseer decision points populate the intervention timeline via the live wiring > failed executor with no error source dispatches retry_step and emits a retry entry with attemptCount/attemptLimit | AssertionError: expected undefined to be truthy |
| `Test shard 1/4` | `src/__tests__/planning-evacuation.test.ts` | withdrawing a card from planning > wakes the poll when the card comes back to todo, so planning restarts | TypeError: Cannot read properties of undefined (reading 'length') |
| `Test shard 1/4` | `src/__tests__/plugin-runner.test.ts` | PluginRunner > task lifecycle hooks > should invoke onTaskCompleted when the complete lane is RENAMED | AssertionError: expected "vi.fn()" to be called with arguments: [ 'onTaskCompleted', …(1) ] |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > cleans before the complete-column move for direct-ai-merge | AssertionError: expected 'blocked' to be 'done' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > cleans before the complete-column move for merge-confirmed-fast-path | (no error line in shard log) |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > cleans before the complete-column move for self-healing | AssertionError: expected 'blocked' to be 'done' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > cleans before the complete-column move for workflow-graph-merge-finalize | (no error line in shard log) |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > does no git work for a workspace-shaped task without a singular worktree | AssertionError: expected 'blocked' to be 'done' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > finalizes a durable landing when cleanup preserves content | AssertionError: expected 'blocked' to be 'done' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > keeps an active-session worktree while still moving the task to complete | AssertionError: expected 'blocked' to be 'done' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > reclaims an already-complete task through the convergence path | AssertionError: expected 'blocked' to be 'already-done' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > skips cleanup without a root directory but still completes | AssertionError: expected 'blocked' to be 'done' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/post-landing-worktree-cleanup.test.ts` | cleanupLandedTaskWorktree > still completes when clearing a removed worktree pointer fails | AssertionError: expected 'blocked' to be 'done' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/project-engine-auto-heal-lane-resolved.test.ts` | auto-heal recognises the board's own review lane > forwards the resolved answer through canMergeTask | TypeError: reviewColumns.has is not a function |
| `Test shard 1/4` | `src/__tests__/project-engine-auto-heal-lane-resolved.test.ts` | the in-review enqueue sweep resolves each card's own review lane > enqueues a retry-exhausted healable card sitting in a RENAMED review lane | TypeError: this.resolveMergeGateBlocker is not a function |
| `Test shard 1/4` | `src/__tests__/project-engine-auto-heal-lane-resolved.test.ts` | the in-review enqueue sweep resolves each card's own review lane > shares ONE IR read across a multi-card sweep rather than resolving per card | TypeError: this.resolveMergeGateBlocker is not a function |
| `Test shard 1/4` | `src/__tests__/project-engine.test.ts` | ProjectEngine paused in-review auto-merge behavior > FN-5627: fast-path still works when mergeConfirmed has no commitSha (verified-no-op path) | AssertionError: expected "vi.fn()" to be called with arguments: [ 'task:merged', ObjectContaining{…} ] |
| `Test shard 1/4` | `src/__tests__/project-engine.test.ts` | ProjectEngine paused in-review auto-merge behavior > emits task:merged when mergeConfirmed fast-path finalizes to done | AssertionError: expected "vi.fn()" to be called with arguments: [ 'task:merged', ObjectContaining{…} ] |
| `Test shard 1/4` | `src/__tests__/project-engine.test.ts` | ProjectEngine workspace merge dispatch hardening (Phase C review) > B2: merge-confirmed workspace task skips the root-cwd reachability gate (not demoted) | AssertionError: expected "vi.fn()" to be called with arguments: [ 'task:merged', …(1) ] |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/in-review-stall-deadlock-disposition.test.ts` | reliability interactions: in-review stall deadlock disposition > FN-6070: rejected limbo requeues do not increment into deadlock disposition | AssertionError: expected 1 to be +0 // Object.is equality |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/landed-content-soft-blocker.real-git.test.ts` | landed-content soft-blocker reliability interactions (real git) > keeps task in-review when landed content exists but hard blockers remain | AssertionError: expected 1 to be +0 // Object.is equality |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/planning-dependency-release.pg.test.ts` | FN-8768 planning dependency release interactions > finalizes a persisted plan without reacquiring its PostgreSQL lifecycle lock | AssertionError: expected false to be true // Object.is equality |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/post-finalize-verification-noop-status-write.test.ts` | post-finalize verification noop status-write guard > keeps done task unchanged on 'at-cap' write path | AssertionError: expected [] to have a length of 1 but got +0 |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/post-finalize-verification-noop-status-write.test.ts` | post-finalize verification noop status-write guard > keeps done task unchanged on 'under-cap' write path | AssertionError: expected [] to have a length of 1 but got +0 |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/post-finalize-verification-noop.real-git.test.ts` | post-finalize verification failure reliability interactions (real git) > keeps finalized already-on-main tasks in done when delayed verification fails | AssertionError: expected false to be true // Object.is equality |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/reap-unregistered-orphans-defers-active-session.test.ts` | FN-4811 / FN-5065: reapUnregisteredOrphans defers active-session paths > FN-5065 control: removes unregistered orphan when no FN-4811 active session is registered | AssertionError: expected +0 to be 1 // Object.is equality |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/secrets-env-materialization.test.ts` | reliability interactions: secrets env materialization > adopts a planning-era legacy sidecar before linked-worktree refresh while real dirt still blocks | AssertionError: promise rejected "TypeError: The "paths[0]" argument must b… { code: '…' }" instead of resolving |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/secrets-env-materialization.test.ts` | reliability interactions: secrets env materialization > orphan reap reclaims orphaned env artifacts | AssertionError: expected +0 to be 1 // Object.is equality |
| `Test shard 1/4` | `src/__tests__/reliability-interactions/soft-blocker-auto-finalize-interactions.real-git.test.ts` | soft-blocker auto-finalize reliability interactions (real git) > preserves hard blockers, then finalizes via recoverMergedReviewTasks when blocker clears | AssertionError: expected 1 to be +0 // Object.is equality |
| `Test shard 1/4` | `src/__tests__/self-healing-ghost-branch-recovery.test.ts` | self-healing ghost branch reclaim > recovers tip-already-merged FN-4471 signature by clearing cached metadata | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-9001', 'in-progress', …(1) ] |
| `Test shard 1/4` | `src/__tests__/self-healing-pr-conflict.test.ts` | SelfHealingManager.reclaimPrConflictForTask > returns reclaimed for reclaimable conflicts with derived engine provenance | AssertionError: expected false to be true // Object.is equality |
| `Test shard 1/4` | `src/__tests__/self-healing-reattach-orphaned-executions.test.ts` | FN-6336: reattach orphaned assigned in-progress executions > is registered after agent and stale-run recovery in startup and periodic self-healing loops | AssertionError: expected -1 to be greater than or equal to 0 |
| `Test shard 1/4` | `src/__tests__/self-healing-rebound-target-renamed-hold.test.ts` | the self-healing rebound TARGET follows the board's own hold lane > default vocabulary: still rebounds to `todo` when no workflow resolves | AssertionError: expected "vi.fn()" to be called at least once |
| `Test shard 1/4` | `src/__tests__/self-healing-rebound-target-renamed-hold.test.ts` | the self-healing rebound TARGET follows the board's own hold lane > rebounds an in-review card with unmet dependencies to the RENAMED hold lane | AssertionError: expected "vi.fn()" to be called at least once |
| `Test shard 1/4` | `src/__tests__/self-healing-unproven-review-approval.test.ts` | reconcileUnprovenReviewApprovals > repairs the exact singular wedge and exposes both recovery blocker shapes | AssertionError: expected 'task has enabled pre-merge workflow s…' to be 'task has enabled pre-merge workflow s…' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/self-healing-workspace.test.ts` | FN-9048 workspace archive restore reaches self-healing cleanly > archives, disposes, restores, then skips FORK-A after its stale map is reconciled | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-9048-RESTORE-E2E', …(1) ] |
| `Test shard 1/4` | `src/__tests__/triage-planning-slot-release-wake.test.ts` | planning-slot release wakes > wakes after a rejected planning promise without leaking an unhandled rejection | AssertionError: expected "requestImmediatePoll" to be called 1 times, but got 0 times |
| `Test shard 1/4` | `src/__tests__/workflow-graph-executor-retry-coding-workflow.test.ts` | WorkflowGraphExecutor built-in coding workflow retries > retries the execute node on exception then succeeds | AssertionError: expected [ 'start', 'planning', …(11) ] to deeply equal [ 'start', 'planning', …(10) ] |
| `Test shard 1/4` | `src/__tests__/workflow-graph-optional-group.test.ts` | WorkflowGraphExecutor optional-group > cycles REVISE findings across graph runs until APPROVE, and falls through only after the budget seam declines | AssertionError: expected [ 'review' ] to include 'after' |
| `Test shard 1/4` | `src/__tests__/workflow-graph-optional-group.test.ts` | WorkflowGraphExecutor optional-group > falls through unchanged when the pre-merge fix seam is absent or declines | AssertionError: expected [ 'review' ] to include 'after' |
| `Test shard 1/4` | `src/__tests__/workflow-graph-optional-group.test.ts` | WorkflowGraphExecutor optional-group > repairs missing Plan Review result from the latest completed log before execution | AssertionError: expected 'failure' to be 'success' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/workflow-graph-optional-step-fix.test.ts` | TaskExecutor pre-merge optional-step fix seam > forwards persisted review findings into failed-step recovery remediation | AssertionError: expected "sendTaskBackForFix" to be called with arguments: [ { id: 'FN-7066', …(14) }, …(11) ] |
| `Test shard 1/4` | `src/__tests__/workflow-graph-optional-step-fix.test.ts` | TaskExecutor pre-merge optional-step fix seam > keeps the retry presentation aligned with the next attempt during failed-step recovery | AssertionError: expected "sendTaskBackForFix" to be called with arguments: [ { id: 'FN-7066', …(14) }, …(11) ] |
| `Test shard 1/4` | `src/__tests__/workflow-lifecycle-live-e2e.pg.test.ts` | live lifecycle E2E: real graph + real PostgreSQL store > scenario 6 — a REVISE verdict routes the card back to wip > does the same on a MERGED board, without bouncing to the dual-role column | AssertionError: expected [ 'planning', 'execute', 'review' ] to deeply equal [ 'planning', 'execute', …(4) ] |
| `Test shard 1/4` | `src/__tests__/workflow-lifecycle-live-e2e.pg.test.ts` | live lifecycle E2E: real graph + real PostgreSQL store > scenario 6 — a REVISE verdict routes the card back to wip > re-enters exec on a REVISE and only completes after the second review (renamed board) | AssertionError: expected [ 'planning', 'execute', 'review' ] to deeply equal [ 'planning', 'execute', …(4) ] |
| `Test shard 1/4` | `src/__tests__/workflow-planning-continuation-terminal-gap-live-e2e.pg.test.ts` | planning-continuation terminal columns, measured on a live store > AUDIT — the inner predicate is threaded; one of the two classifier call sites still is not | AssertionError: expected [ [ …(2), pos: 12827, …(3) ], …(1) ] to have a length of 1 but got 2 |
| `Test shard 1/4` | `src/__tests__/workflow-rebound-family-live-e2e.pg.test.ts` | live rebound E2E: where a recovered card goes back to > autoRecoverWorktreeSessionStartFailure — the session-start requeue > requeues a recovered card to the RENAMED workflow's rebound column | AssertionError: expected 'building' to be 'backlog' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/workflow-rebound-family-live-e2e.pg.test.ts` | live rebound E2E: where a recovered card goes back to > autoRecoverWorktreeSessionStartFailure — the session-start requeue > still requeues a default-vocabulary card to `todo` (regression floor) | AssertionError: expected 'in-progress' to be 'todo' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/workflow-step-notes-repair.test.ts` | workflow-step verdict note repair > keeps repaired review outcomes unchanged with an hanging run-audit sink | AssertionError: expected "vi.fn()" to be called with arguments: [ ObjectContaining{…} ] |
| `Test shard 1/4` | `src/__tests__/workflow-step-notes-repair.test.ts` | workflow-step verdict note repair > keeps repaired review outcomes unchanged with an rejecting run-audit sink | AssertionError: expected "vi.fn()" to be called with arguments: [ ObjectContaining{…} ] |
| `Test shard 1/4` | `src/__tests__/workflow-step-notes-repair.test.ts` | workflow-step verdict note repair > keeps repaired review outcomes unchanged with an throwing run-audit sink | (no error line in shard log) |
| `Test shard 1/4` | `src/__tests__/workflow-step-notes-repair.test.ts` | workflow-step verdict note repair > narrates an unchanged legacy review whose persisted output and notes are empty | AssertionError: expected { success: true, …(5) } to match object { verdict: 'APPROVE', …(2) } |
| `Test shard 1/4` | `src/__tests__/workflow-task-runtime.test.ts` | WorkflowTaskRuntime > passes undefined attachments through built-in workflow execution when absent | AssertionError: expected 'failed' to be 'completed' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/workflow-task-runtime.test.ts` | WorkflowTaskRuntime > preserves attachments through built-in workflow execution | AssertionError: expected 'failed' to be 'completed' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/workflow-task-runtime.test.ts` | WorkflowTaskRuntime > resolves an unselected task to the built-in coding workflow instead of falling back | AssertionError: expected 'failed' to be 'completed' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/workflow-task-runtime.test.ts` | WorkflowTaskRuntime > runs the pre-merge browser-verification optional-group once when enabled, before review | AssertionError: expected 'failed' to be 'completed' // Object.is equality |
| `Test shard 1/4` | `src/__tests__/workspace-merger-lease.test.ts` | workspace land dispatch finalization (PostgreSQL) > fences a real repository lander after a successor reclaims its durable repo lease | AssertionError: expected Error: Workspace repositories modified ou… to match object { …(2) } |
| `Test shard 1/4` | `src/__tests__/workspace-merger-lease.test.ts` | workspace land dispatch finalization (PostgreSQL) > leaves a real pushed land unfinalized when a successor reclaims the dispatch fence | AssertionError: expected Error: Workspace repositories modified ou… to be an instance of WorkspaceMergeDispatchSupersededError |
| `Test shard 1/4` | `src/__tests__/workspace-merger-lease.test.ts` | workspace land dispatch finalization (PostgreSQL) > rejects a predecessor's real repo-b push after a successor republished its dispatch fence | AssertionError: expected Error: Workspace repositories modified ou… to match object { …(2) } |
| `Test shard 1/4` | `src/__tests__/workspace-review-remediation-routing.test.ts` | workspace named Code Review remediation routing > releases a finding-less revise without inventing work | AssertionError: expected true to be false // Object.is equality |
| `Test shard 1/4` | `src/__tests__/workspace-review-remediation-routing.test.ts` | workspace named Code Review remediation routing > releases qualified findings outside the confirmed workspace repository scope | AssertionError: expected true to be false // Object.is equality |
| `Test shard 1/4` | `src/executor/__tests__/external-checkout-extraction-guards.test.ts` | executor extraction safety guards > keeps operator-owned external checkouts outside managed worktree preflight and cleanup | AssertionError: expected [ …(3) ] to have a length of 5 but got 3 |
| `Test shard 2/4` | `src/__tests__/agent-document-tools.test.ts` | task_prompt_write tool > confirms a workspace prompt after atomically publishing its validated repository scope | AssertionError: expected "vi.fn()" to be called with arguments: [ Array(3) ] |
| `Test shard 2/4` | `src/__tests__/authoritative-gate-result-routing.test.ts` | authoritative gate-result routing > requires an approving durable verdict for optional required reviews | AssertionError: expected [ { workflowStepId: 'review', …(8) } ] to match object [ { status: 'passed', …(3) } ] |
| `Test shard 2/4` | `src/__tests__/benchmark-six-column-workflow.test.ts` | builtin:coding parity alongside the benchmark (R8) > keeps the default pipeline trace byte-identical and lands its merge in in-review | AssertionError: expected [ 'start', 'plan', …(13) ] to deeply equal [ 'start', 'plan', …(12) ] |
| `Test shard 2/4` | `src/__tests__/builtin-workflows-lifecycle.test.ts` | built-in workflow lifecycle smoke > builtin:legacy-coding > walks its own ordered column trail with no skipped or foreign columns | AssertionError: expected [ [ 'triage', 'todo', 'graph' ], …(3) ] to deeply equal [ [ 'triage', 'todo', 'graph' ], …(5) ] |
| `Test shard 2/4` | `src/__tests__/executor-contamination-base.test.ts` | branch cross-contamination recovery (FN-4428/FN-4499) > auto-recovers obviously misrouted .changeset-only foreign commits and emits audit | AssertionError: expected "autoRecoverCrossContamination" to be called with arguments: [ ObjectContaining{…} ] |
| `Test shard 2/4` | `src/__tests__/executor-contamination-base.test.ts` | branch cross-contamination recovery (FN-4428/FN-4499) > drops already-upstream + misrouted together then escalates on second contamination | AssertionError: expected "autoRecoverCrossContamination" to be called with arguments: [ ObjectContaining{…} ] |
| `Test shard 2/4` | `src/__tests__/executor-contamination-base.test.ts` | branch cross-contamination recovery (FN-4428/FN-4499) > falls back to existing auto-recovery when contamination is post-start | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-4428', 'todo', { …(2) } ] |
| `Test shard 2/4` | `src/__tests__/executor-contamination-base.test.ts` | branch cross-contamination recovery (FN-4428/FN-4499) > falls back to terminal contamination failure when bootstrap reanchor throws | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-4488', ObjectContaining{…} ] |
| `Test shard 2/4` | `src/__tests__/executor-contamination-base.test.ts` | branch cross-contamination recovery (FN-4428/FN-4499) > keeps escalation path for foreign commits that touch shared paths | AssertionError: expected "autoRecoverCrossContamination" to not be called at all, but actually been called 1 times |
| `Test shard 2/4` | `src/__tests__/executor-explicit-duplicate-recovery.test.ts` | executor explicit duplicate redirect parse recovery > rebounds a title-only custom-prefix redirect after a parse failure | AssertionError: expected "vi.fn()" to be called with arguments: [ 'KB-124', …(3) ] |
| `Test shard 2/4` | `src/__tests__/executor-implicit-task-done-budget.test.ts` | FN-4946 implicit refusal budget handling > resets taskDoneRetryCount after later clean completion | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-4946-B3', 'in-review', …(1) ] |
| `Test shard 2/4` | `src/__tests__/executor-implicit-task-done-budget.test.ts` | FN-4946 implicit refusal budget handling > shares retry budget with explicit fn_task_done refusals | TypeError: Cannot read properties of undefined (reading 'execute') |
| `Test shard 2/4` | `src/__tests__/executor-review-artifacts.test.ts` | TaskExecutor feature-video completion handoff > preserves graph-start input language when review handoff sees edited task settings and description | AssertionError: expected { mode: 'input', …(2) } to match object { mode: 'input', locale: 'fr' } |
| `Test shard 2/4` | `src/__tests__/executor-task-done-revise-verdict-guard.test.ts` | FN-4851 REVISE verdict task-done guard > ignores REVISE verdict on already done or skipped steps | TypeError: Cannot read properties of undefined (reading 'execute') |
| `Test shard 2/4` | `src/__tests__/executor-workspace-main-checkout-guard.test.ts` | workspace main-checkout guard > warns rather than blocks provably old operator dirt and ignores nested worktrees | AssertionError: expected [ { repo: 'repo-a', …(3) } ] to deep equally contain ObjectContaining{…} |
| `Test shard 2/4` | `src/__tests__/group-merge-coordinator.test.ts` | resolveBranchGroupMergeRouting > holds a user-off member before release, then lands exactly once on its mission branch | TypeError: Cannot read properties of undefined (reading 'has') |
| `Test shard 2/4` | `src/__tests__/group-merge-coordinator.test.ts` | resolveBranchGroupMergeRouting > keeps the post-Code-Review main collision manual while merging the dedicated-branch control | ReferenceError: store is not defined |
| `Test shard 2/4` | `src/__tests__/lifecycle-move-reason-census.test.ts` | engine lifecycle move reason census > pins the production move authority inventory | AssertionError: expected 52 to be 53 // Object.is equality |
| `Test shard 2/4` | `src/__tests__/mcp-builtin-lane-coverage.test.ts` | fusion-memory MCP lane ledger > maps every resolver call across all roots to one required bucket | AssertionError: expected [ { …(2) }, { …(2) }, { …(2) }, …(34) ] to deeply equal [ { …(2) }, { …(2) }, { …(2) }, …(34) ] |
| `Test shard 2/4` | `src/__tests__/merge-abort-clears-transient-status.test.ts` | ProjectEngine aborted merge stamp cleanup > clears a manual abort's landing stamp before its rejection handler starts a successor merge | AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times |
| `Test shard 2/4` | `src/__tests__/merge-abort-clears-transient-status.test.ts` | ProjectEngine aborted merge stamp cleanup > clears a manual abort's merging stamp before its rejection handler starts a successor merge | (no error line in shard log) |
| `Test shard 2/4` | `src/__tests__/merge-abort-clears-transient-status.test.ts` | ProjectEngine aborted merge stamp cleanup > clears a manual abort's merging-fix stamp before its rejection handler starts a successor merge | (no error line in shard log) |
| `Test shard 2/4` | `src/__tests__/merge-abort-clears-transient-status.test.ts` | ProjectEngine aborted merge stamp cleanup > clears a manual abort's merging-pr stamp before its rejection handler starts a successor merge | (no error line in shard log) |
| `Test shard 2/4` | `src/__tests__/merge-abort-clears-transient-status.test.ts` | ProjectEngine aborted merge stamp cleanup > clears a manual abort's reviewing stamp before its rejection handler starts a successor merge | AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times |
| `Test shard 2/4` | `src/__tests__/merge-abort-clears-transient-status.test.ts` | ProjectEngine aborted merge stamp cleanup > runs the PR pump reconcile before its production dispatch body | AssertionError: promise rejected "TypeError: Cannot read properties of unde…" instead of resolving |
| `Test shard 2/4` | `src/__tests__/merge-abort-clears-transient-status.test.ts` | ProjectEngine aborted merge stamp cleanup > runs the direct pump reconcile before the body observes an orphaned landing stamp | AssertionError: promise rejected "TypeError: Cannot read properties of unde…" instead of resolving |
| `Test shard 2/4` | `src/__tests__/merge-abort-clears-transient-status.test.ts` | ProjectEngine aborted merge stamp cleanup > runs the direct pump reconcile before the body observes an orphaned merging stamp | AssertionError: promise rejected "TypeError: Cannot read properties of unde…" instead of resolving |
| `Test shard 2/4` | `src/__tests__/merge-orphan-durable-write-inventory-drift.test.ts` | FN-8923 orphan durable-write inventory drift guard > is bijective by call-site id and fingerprint and fails closed on suspects | AssertionError: new durable write is not classified: expected [ …(416) ] to deeply equal [ …(394) ] |
| `Test shard 2/4` | `src/__tests__/merge-orphan-durable-write-inventory-drift.test.ts` | FN-8923 orphan durable-write inventory drift guard > pins derived writer surface and closure | AssertionError: reachable module is not pinned in scannedModules: expected [ …(330) ] to deeply equal [ …(323) ] |
| `Test shard 2/4` | `src/__tests__/merge-orphan-durable-write-inventory-drift.test.ts` | FN-8923 orphan durable-write inventory drift guard > rebuilds a current manifest without changing it | AssertionError: expected { inventoryStatus: 'final', …(6) } to deeply equal { inventoryStatus: 'final', …(6) } |
| `Test shard 2/4` | `src/__tests__/mission-autopilot-end-to-end.test.ts` | mission autopilot end-to-end wiring > advances slices in no-assertions pass path | AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times |
| `Test shard 2/4` | `src/__tests__/mission-autopilot-end-to-end.test.ts` | mission autopilot end-to-end wiring > emits mission error event when validator returns error | AssertionError: expected "vi.fn()" to be called with arguments: [ 'VR-001', 'error', …(1) ] |
| `Test shard 2/4` | `src/__tests__/mission-autopilot-end-to-end.test.ts` | mission autopilot end-to-end wiring > marks recovered done-task features complete after validation pass | AssertionError: expected "vi.fn()" to be called with arguments: [ 'VR-001', 'passed', 'ok' ] |
| `Test shard 2/4` | `src/__tests__/mission-autopilot-end-to-end.test.ts` | mission autopilot end-to-end wiring > runs validation and advances next slice when a linked task is moved to done | AssertionError: expected 'in-progress' to be 'done' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/pi-reasoning-summary.test.ts` | createFnAgent reasoning-summary payload hook > chains an upstream replacement and preserves it when Fusion makes no change | AssertionError: expected { reasoning: { …(2) }, …(1) } to deeply equal { reasoning: { …(2) }, …(1) } |
| `Test shard 2/4` | `src/__tests__/pi-reasoning-summary.test.ts` | createFnAgent reasoning-summary payload hook > installs onPayload on every created pi session | AssertionError: expected undefined to deeply equal Any<Function> |
| `Test shard 2/4` | `src/__tests__/pi-reasoning-summary.test.ts` | createFnAgent reasoning-summary payload hook > retries once on the same session after an unsupported-summary rejection | Error: Unsupported reasoning summary: detailed |
| `Test shard 2/4` | `src/__tests__/pi-reasoning-summary.test.ts` | createFnAgent reasoning-summary payload hook > upgrades a Responses request while preserving its effort | AssertionError: expected undefined to deeply equal { reasoning: { …(2) } } |
| `Test shard 2/4` | `src/__tests__/planning-continuation-renamed-lane-dispatch.test.ts` | planning-continuation admission resolves terminal columns from the task's board > does NOT admit a continuation for a card sitting in the renamed COMPLETE lane | AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times |
| `Test shard 2/4` | `src/__tests__/project-engine-merge-lane-fixture-drift.test.ts` | ProjectEngine merge-lane fixture drift > requires prototype merge fakes to seed every auto-merge state field they can exercise | AssertionError: ProjectEngine auto-merge field "mergeRetryResetTaskIds" is not seeded by _project-engine-merge-lane-fixture.ts. Add its production-equivalent default to seedMergeLa |
| `Test shard 2/4` | `src/__tests__/project-engine-merge-lane-resolved.test.ts` | the other merge-lane surfaces on a renamed board > passes the resolved lane from the final dequeue into the merge blocker | TypeError: store.logEntry is not a function |
| `Test shard 2/4` | `src/__tests__/project-engine-merge-lane-resolved.test.ts` | the other merge-lane surfaces on a renamed board > passes the resolved lane from the periodic sweep into the merge blocker | TypeError: this.resolveMergeGateBlocker is not a function |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/auto-revive-and-watchdog.test.ts` | reliability interactions: auto-revive + watchdog > Case 12: new commits are orthogonal to restart classification | TypeError: store.getTask is not a function |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/auto-revive-and-watchdog.test.ts` | reliability interactions: auto-revive + watchdog > Case 2: completed-step failure message is requeued safely only when no progress | TypeError: store.getTask is not a function |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/executor-no-task-done-vs-worktree-reclaim.test.ts` | reliability interactions: executor no-fn_task_done vs worktree reclaim > missing-worktree session-start error during retry clears metadata and requeues | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-4601', 'todo', { …(3) } ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/executor-pending-review-skip-retry.test.ts` | reliability interactions: FN-5436 executor pending-review skip > FN-5436 composition: implicit-done wins when no in-progress step exists despite stale review logs | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-5436-RI-A', 'in-review', …(1) ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/executor-pending-review-skip-retry.test.ts` | reliability interactions: FN-5436 executor pending-review skip > FN-5436 composition: pending-review park does not consume taskDone requeue budget | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-5436-RI-C', 'in-review', …(1) ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/executor-pending-review-skip-retry.test.ts` | reliability interactions: FN-5436 executor pending-review skip > FN-5436 composition: reclaim-abort path takes precedence over pending-review skip | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-5436-RI-B', 'todo', { …(1) } ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/executor-pending-review-skip-retry.test.ts` | reliability interactions: FN-5436 executor pending-review skip > FN-5436 composition: recoverApprovedStepsOnResume leaves pending-review skip disabled after approval resolves step | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-5436-RI-D', 'in-review', …(1) ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/executor-pending-review-skip-retry.test.ts` | reliability interactions: FN-5436 executor pending-review skip > FN-5436 negative: plan-review UNAVAILABLE advisory remains non-blocking | AssertionError: expected [] to have a length of 4 but got +0 |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/foreign-start-point-no-owned-commit.real-git.test.ts` | foreign start-point no-owned-commit interactions (real git) > merger no-op gate blocks done and auto-requeues to todo | AssertionError: expected 'in-review' to be 'todo' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/graph-node-missing-worktree-recovery.test.ts` | Plan Review missing-worktree repo-root fallback (FN-7996) > re-acquires a task worktree for Plan Review when the recorded worktree is gone (never the repo root) | Error: pinned branch probe returned no registered worktrees for /tmp/test; cannot confirm branch of /tmp/test/.fusion/worktrees/fn-7996-t (transient git failure) — refusing to prov |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/graph-node-missing-worktree-recovery.test.ts` | graph-node unusable-worktree failure recovery (FN-7996) > detects the refusal on foreach `container#N:template` materialized ids | AssertionError: expected 'in-progress' to be 'todo' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/graph-node-missing-worktree-recovery.test.ts` | graph-node unusable-worktree failure recovery (FN-7996) > recovers when the refusal is only present under the materialized instance error key | AssertionError: expected 'in-progress' to be 'todo' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/graph-node-missing-worktree-recovery.test.ts` | graph-node unusable-worktree failure recovery (FN-7996) > requeues to todo with cleared worktree metadata instead of terminal-parking | AssertionError: expected 'in-progress' to be 'todo' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/graph-node-missing-worktree-recovery.test.ts` | graph-node unusable-worktree failure recovery (FN-7996) > still recovers in-review tasks when auto-merge processing is allowed | AssertionError: expected 'in-review' to be 'todo' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/graph-node-missing-worktree-recovery.test.ts` | graph-node unusable-worktree failure recovery (FN-7996) > terminal-parks visibly once the worktree-session retry budget is exhausted | AssertionError: expected null to be 'failed' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/merge-retry-rejection-parks-task.test.ts` | routeGraphMergeFailureToRetry — rejected merge requester > does not park a replacement execution when boundary preparation returns blocked | AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validation-trigger-gap.test.ts` | FN-5715 reliability: mission validation trigger gap > keeps backfill optional because runtime lazy-ensure routes through validator | AssertionError: expected "vi.fn()" to be called with arguments: [ 'VR-001', 'passed', 'ok' ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > AE2: behavioral assertion the judge calls pass → fails with no verification capability | AssertionError: expected "vi.fn()" to be called with arguments: [ Any<String>, 'failed', Any<String> ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > AE3: static assertion the judge calls pass → passes, no verification invoked | AssertionError: expected "vi.fn()" to be called with arguments: [ Any<String>, 'passed', Any<String> ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > U6/R16+R21: an INCONCLUSIVE verdict emits a distinguishable infra-failure event and no Fix Feature | AssertionError: expected "vi.fn()" to be called with arguments: [ Any<String>, 'blocked', Any<String> ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > U6/R16: a swallowed Fix-Feature triage error is durably recorded, not silent | AssertionError: expected undefined to be defined |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > U6/R16: a verification FAILURE emits a persisted mission event with outcome=fail | AssertionError: expected undefined to be defined |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > U6/R6: failed verification passes the observed-vs-expected reason to the Fix Feature | AssertionError: expected "vi.fn()" to be called at least once |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > behavioral assertion confirmed by an injected verification capability → passes | AssertionError: expected "vi.fn()" to be called with arguments: [ Any<String>, 'passed', Any<String> ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > behavioral assertion verification inconclusive → blocked, NO fix feature | AssertionError: expected "vi.fn()" to be called with arguments: [ Any<String>, 'blocked', Any<String> ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > mixed set: behavioral observed wrong → overall fail even though static passes | AssertionError: expected "vi.fn()" to be called with arguments: [ Any<String>, 'failed', Any<String> ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > mixed set: static passes via judge, behavioral confirmed via verification → overall pass | AssertionError: expected "vi.fn()" to be called with arguments: [ Any<String>, 'passed', Any<String> ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts` | Validator behavioral posture (U2 + U3) > untyped assertions default to static — legacy judge pass path is preserved | AssertionError: expected "vi.fn()" to be called with arguments: [ Any<String>, 'passed', Any<String> ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/post-done-continuation-no-wedge.test.ts` | FN-5866 reliability interactions: post-done continuation no wedge > falls through to terminal failure after the non-continuable fresh-session retry budget is exhausted | Error: Test timed out in 30000ms. |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/pr-conflict-reclaim.test.ts` | reliability interaction: pr conflict reclaim > keeps paused-review reclaim path resumable | AssertionError: expected 'in-review' to be 'in-progress' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/reclaim-phantom-executor-binding.test.ts` | FN-6736: phantom executor binding reclaim > does not increment FN-5704 resume-limbo counters on the phantom-binding requeue | AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/reclaim-phantom-executor-binding.test.ts` | FN-6736: phantom executor binding reclaim > requeues an old in-progress task when executor-active is only a phantom binding | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-6736', 'todo', …(1) ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/reclaim-self-owned-resume-limbo-escalation.test.ts` | FN-5704: reclaim self-owned resume limbo escalation > escalates frozen in-progress reclaim/resume loops to todo with preserve flags and audit event | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-5704', 'todo', …(1) ] |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/self-healing-interactions.test.ts` | reliability interactions: self-healing > recoverMissingWorktreeReviewFailures rebounds no-progress review tasks for 'Refusing to start coding agent in incomplete worktree: /tmp/wt' | AssertionError: expected 'in-review' to be 'todo' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/self-healing-interactions.test.ts` | reliability interactions: self-healing > recoverMissingWorktreeReviewFailures rebounds no-progress review tasks for 'Refusing to start coding agent in missing worktree: /tmp/wt' | (no error line in shard log) |
| `Test shard 2/4` | `src/__tests__/reliability-interactions/self-healing-interactions.test.ts` | reliability interactions: self-healing > recoverMissingWorktreeReviewFailures rebounds no-progress review tasks for 'Refusing to start coding agent in unregistered git worktree: /tmp/wt' | AssertionError: expected 'in-review' to be 'todo' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/restart-recovery-coordinator.test.ts` | RestartRecoveryCoordinator > requeues interrupted failed tasks with no progress, then resumes remaining orphans | TypeError: store.getTask is not a function |
| `Test shard 2/4` | `src/__tests__/restart-recovery-coordinator.test.ts` | restart recovery resolves the board's own wip lane > requeues an interrupted task sitting in a RENAMED wip lane | TypeError: store.getTask is not a function |
| `Test shard 2/4` | `src/__tests__/review-inline-fix-fingerprint-recapture.real-git.test.ts` | inline review fingerprint recapture > executes, persists, gates, reroutes, and converges a reviewer inline fix without mutating its sibling lane | AssertionError: expected { success: true, …(7) } to match object { verdict: 'APPROVE', …(2) } |
| `Test shard 2/4` | `src/__tests__/self-healing-orphan-only-scope.real-git.test.ts` | recoverOrphanOnlyScopeViolations (real git) > finalizes orphan-only scope violation as no-op when task work is already on main (FN-4350) | AssertionError: expected true to be false // Object.is equality |
| `Test shard 2/4` | `src/__tests__/self-healing-reclaim-paused-review.test.ts` | self-healing reclaim paused review > reclaims paused in-review branch conflict, clears paused state, and requeues to todo with audit metadata | AssertionError: expected "vi.fn()" to be called with arguments: [ 'FN-4485', 'in-progress', …(1) ] |
| `Test shard 2/4` | `src/__tests__/self-healing-stranded-todo-renamed-hold.test.ts` | recoverStrandedCompletedTodoTasks under a renamed hold column > falls back to the legacy todo column when the workflow cannot be resolved | AssertionError: expected +0 to be 1 // Object.is equality |
| `Test shard 2/4` | `src/__tests__/self-healing-tempdir-sweep.test.ts` | SelfHealingManager temp-dir AI merge worktree sweep > retains a worktree for an archived task outside a physical terminal lane | AssertionError: expected 1 to be +0 // Object.is equality |
| `Test shard 2/4` | `src/__tests__/triage-pause-abort.test.ts` | TriageProcessor per-task pause aborts > aborts and disposes an active specify session on task:updated pause without moving to todo | TypeError: Cannot read properties of undefined (reading 'length') |
| `Test shard 2/4` | `src/__tests__/triage-pause-abort.test.ts` | TriageProcessor per-task pause aborts > does not abort on non-paused updates or paused ids with no active session | AssertionError: expected [Function] to not throw an error but 'TypeError: Cannot read properties of …' was thrown |
| `Test shard 2/4` | `src/__tests__/triage-pause-abort.test.ts` | TriageProcessor per-task pause aborts > treats userPaused task updates as pause aborts | TypeError: Cannot read properties of undefined (reading 'length') |
| `Test shard 2/4` | `src/__tests__/workflow-file-scope-lease-caller-gap-live-e2e.pg.test.ts` | file-scope lease: the converted call site against the unconverted one > SOURCE-LEVEL — both self-healing overlap mirrors pass resolved lifetime roles | AssertionError: expected 'blocker, allTasks, {\n          merge…' to match /isWipColumn:\s*\w+\.has\(\w+\.column\)/ |
| `Test shard 2/4` | `src/__tests__/workflow-graph-merge-region-collapse.test.ts` | WorkflowGraphExecutor merge-region collapse > collapses the built-in merge-policy region to one legacy merge seam | AssertionError: expected [ 'start', 'planning', …(11) ] to deeply equal [ 'start', 'planning', …(10) ] |
| `Test shard 2/4` | `src/__tests__/workflow-graph-merge-region-collapse.test.ts` | WorkflowGraphExecutor merge-region collapse > treats 'branch-group-member-integration' as a merge-region boundary when entered directly | AssertionError: expected [ 'start', 'planning', …(11) ] to deeply equal [ 'start', 'planning', …(10) ] |
| `Test shard 2/4` | `src/__tests__/workflow-graph-merge-region-collapse.test.ts` | WorkflowGraphExecutor merge-region collapse > treats 'branch-group-promotion' as a merge-region boundary when entered directly | AssertionError: expected [ 'start', 'planning', …(11) ] to deeply equal [ 'start', 'planning', …(10) ] |
| `Test shard 2/4` | `src/__tests__/workflow-graph-merge-region-collapse.test.ts` | WorkflowGraphExecutor merge-region collapse > treats 'manual-merge-hold' as a merge-region boundary when entered directly | (no error line in shard log) |
| `Test shard 2/4` | `src/__tests__/workflow-graph-merge-region-collapse.test.ts` | WorkflowGraphExecutor merge-region collapse > treats 'merge-attempt' as a merge-region boundary when entered directly | (no error line in shard log) |
| `Test shard 2/4` | `src/__tests__/workflow-graph-merge-region-collapse.test.ts` | WorkflowGraphExecutor merge-region collapse > treats 'merge-gate' as a merge-region boundary when entered directly | (no error line in shard log) |
| `Test shard 2/4` | `src/__tests__/workflow-graph-merge-region-collapse.test.ts` | WorkflowGraphExecutor merge-region collapse > treats 'recovery-router' as a merge-region boundary when entered directly | (no error line in shard log) |
| `Test shard 2/4` | `src/__tests__/workflow-graph-merge-region-collapse.test.ts` | WorkflowGraphExecutor merge-region collapse > treats 'retry-backoff' as a merge-region boundary when entered directly | (no error line in shard log) |
| `Test shard 2/4` | `src/__tests__/workflow-node-execution-needs.test.ts` | workflowNodeRequiresWorktree > requires a worktree for inline fixes from review name | AssertionError: expected false to be true // Object.is equality |
| `Test shard 2/4` | `src/__tests__/workflow-node-execution-needs.test.ts` | workflowNodeRequiresWorktree > requires a worktree for inline fixes from verification name | AssertionError: expected false to be true // Object.is equality |
| `Test shard 2/4` | `src/__tests__/workspace-acquire-lease-authority.test.ts` | workspace acquire durable lease authority > admits a new owner when an expired durable lease has a stale same-process cache | AssertionError: expected '/tmp/fusion-test-workers-xiv9Xv/redir…' to contain '.worktrees' |
| `Test shard 2/4` | `src/__tests__/workspace-file-overlap-parity.test.ts` | workspace implementation base-refresh enablement > forwards refresh only from a code node through graph preparation | AssertionError: expected 2nd "vi.fn()" call to have been called with [ { id: 'FN-273', …(7) }, {}, …(2) ], but called only 1 times |
| `Test shard 2/4` | `src/__tests__/workspace-review-diff-base.test.ts` | workspace Code Review diff base > threads the per-repository base from the workspace call site into the scope capture | AssertionError: the workspace reviewer must resolve its repository's own base: expected '/**\n * FNXC:CodeOrganization 2026-08…' to contain 'live.workspaceWorktrees?.[repoRelPath…' |
| `Test shard 2/4` | `src/__tests__/worktree-backend-no-execsync.test.ts` | worktree-backend static shellout guard > does not use execSync and always sets timeout for exec/execFile calls | AssertionError: expected 16 to be greater than or equal to 17 |
| `Test shard 2/4` | `src/__tests__/worktree-pinning.test.ts` | worktree-pinning > pinnedWorktreePathForTask > derives <rootDir>/.worktrees/<task-id> by default | AssertionError: expected '/repo/.fusion/worktrees/fn-7996' to be '/repo/.worktrees/fn-7996' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/worktree-pinning.test.ts` | worktree-pinning > preservedWorktreeTargetPathForTask > does not preserve a legacy basename | AssertionError: expected '/repo/.fusion/worktrees/fn-8400' to be '/repo/.worktrees/fn-8400' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/worktree-pinning.test.ts` | worktree-pinning > preservedWorktreeTargetPathForTask > uses the task ID regardless of stale source metadata | AssertionError: expected '/repo/.fusion/worktrees/fn-8400' to be '/repo/.worktrees/fn-8400' // Object.is equality |
| `Test shard 2/4` | `src/__tests__/worktree-reclaim-placement.real-git.test.ts` | reclaimable worktree placement > chooses a task-scoped target when the legacy basename is occupied | Error: Refusing to relocate FN-8400 worktree into its occupied task-ID path: /tmp/fusion-test-workers-xiv9Xv/redir-6416/fn-8400-reclaim-placement-SQ09mB/repo/.worktrees/recover-fn- |
| `Test shard 3/4` | `src/__tests__/bin.test.ts` | bin command routing and fallbacks > configures pi to use .fusion as its project config directory | packages/cli test: AssertionError: expected undefined to be truthy |
| `Test shard 3/4` | `src/__tests__/cli-quiet-prompt-surfaces.test.ts` | CLI quiet prompt and result source contracts > keeps all audited result writers attached to the output seam | packages/cli test: Error: ENOENT: no such file or directory, open '/home/runner/work/Fusion/Fusion/packages/cli/src/commands/research.ts' |
| `Test shard 3/4` | `src/__tests__/docs-screenshot-links.test.ts` | docs screenshot links > points every screenshot image reference at an existing tracked asset | packages/cli test: AssertionError: expected [ …(18) ] to deeply equal [ …(16) ] |
| `Test shard 3/4` | `src/commands/__tests__/skills-get.test.ts` | fn skills get > prints a guide and version from the same built CLI entry point | packages/cli test: Error: Test timed out in 5000ms. |
| `Test shard 4/4` | `src/__tests__/builtin-adjacency-matches-legacy-transitions.test.ts` | built-in workflow adjacency vs the legacy transition table > covers every legacy column, so a new one cannot slip past this pin | AssertionError: expected [] to deeply equal [ 'archived' ] |
| `Test shard 4/4` | `src/__tests__/git-repository.test.ts` | ensureGitRepositoryForProjectPath > keeps the baseline branch for an unborn repository with fetched refs | AssertionError: expected [ { repoRelPath: '.', …(3) } ] to deeply equal [ { repoRelPath: '.', …(3) } ] |
| `Test shard 4/4` | `src/__tests__/git-repository.test.ts` | ensureGitRepositoryForProjectPath > materializes an unambiguous remote-only branch without moving detached HEAD | Error: Command failed: git symbolic-ref -d refs/remotes/origin/HEAD |
| `Test shard 4/4` | `src/__tests__/live-move-path-undeclared-target.test.ts` | live move path — which targets it accepts after the Planning merge > still allows a recovery re-home to reach the workflow's REBOUND TARGET past adjacency | TransitionRejectionError: Cannot move KB-001 to 'todo': Forbidden lifecycle path F2: 'archived' (archived) → 'todo' (hold). Automatic moves may not step backward more than one life |
| `Test shard 4/4` | `src/__tests__/postgres/activity-log-parity.pg.test.ts` | activity log parity (PostgreSQL) > records TaskStore lifecycle events after backend initialization | AssertionError: expected [ { …(7) }, { …(7) } ] to deeply equal ArrayContaining{…} |
| `Test shard 4/4` | `src/__tests__/postgres/create-task-reserved-id.pg.test.ts` | createTaskWithReservedId backend mode (PostgreSQL) > createTaskWithReservedId persists supplied createdAt/updatedAt | AssertionError: expected '2026-09-25T06:39:47.633Z' to be '2026-02-20T12:30:00.000Z' // Object.is equality |
| `Test shard 4/4` | `src/__tests__/postgres/mission-validation-repair.pg.test.ts` | mission validation repair > accepts a matching live fence and records the verified ground truth | RepairGroundTruthStaleError: Ground truth for feature F-MUGLC326-001K-NCYJ changed while repairing |
| `Test shard 4/4` | `src/__tests__/postgres/refine-duplicate-task.pg.test.ts` | refineTask / duplicateTask backend mode (PostgreSQL) > refineTask inherits default-on workflow groups and selection like createTask | AssertionError: expected [ 'plan-review', 'code-review', …(1) ] to deeply equal [ 'plan-review', 'code-review' ] |
| `Test shard 4/4` | `src/__tests__/postgres/refine-duplicate-task.pg.test.ts` | refineTask / duplicateTask backend mode (PostgreSQL) > refineTask persists empty default workflow groups and falls back to the effective default | AssertionError: expected [ 'post-merge-verification' ] to deeply equal [] |
| `Test shard 4/4` | `src/__tests__/postgres/renamed-board-reopen.pg.test.ts` | a renamed board gets the same reopen effects as the default lineage > clears the stale review result when the renamed review lane bounces to the renamed hold lane | TransitionRejectionError: Cannot move KB-001 to 'queued': Forbidden lifecycle path F2: 'checking' (review) → 'queued' (hold). Automatic moves may not step backward more than one li |
| `Test shard 4/4` | `src/__tests__/postgres/store-safe-defaults.pg.test.ts` | TaskStore PostgreSQL safe-default removal > keeps archived logs, comments, documents, and artifacts read-only | AssertionError: expected [Function] to throw error matching /archived.*read-only/ but got 'Task KB-001 is deleted or historical …' |
| `Test shard 4/4` | `src/__tests__/reads-selection-cache-threading.test.ts` | multi-row reads selection-cache threading > prefetches workflow IRs for concurrent list and search hydration only | AssertionError: expected [ NodeObject{ pos: 25915, …(15) } ] to have a length of 2 but got 1 |
