---
title: "fix: Resolve Full Suite hang in @fusion/engine and @fusion/core test groups"
type: fix
status: active
date: 2026-06-21
plan_depth: standard
---

# fix: Resolve Full Suite hang in @fusion/engine and @fusion/core test groups

## Summary

The **Full Suite (non-blocking)** workflow on `main` has been red for 30+ consecutive
runs. The failure is **not** a test assertion — every test that reports a result
passes. Instead, three sharded vitest groups never exit and are SIGKILLed by the
CI wall-clock watchdog when they hit their per-group budget:

| Shard | Group | Watchdog budget | Outcome |
|-------|-------|-----------------|---------|
| 1/4 | `@fusion/engine [1/2]` | 405s | killed at budget → shard fails |
| 2/4 | `@fusion/engine [2/2]` | 405s | killed at budget → shard fails |
| 4/4 | `@fusion/core [2/2]` | 338s | killed at budget → shard fails |
| 3/4 | `@fusion/core [1/2]` | 338s | **passes** (32 heartbeats, then exits) |

The `[1/2]` halves and shard 3 finish well under budget, so this is a **genuine
hang in specific tests** — almost certainly leaked open handles (unterminated git
child processes, intervals/timers, or undrained pools) that prevent vitest from
exiting after the test bodies complete — not uniform slowness. The engine tests
that perform real git worktree/branch operations (`Preparing worktree (new branch
'fusion/fn-001')`, repeated `Switched to branch 'main'`) are the leading suspects.

This plan reproduces the hang locally with hanging-process detection, isolates the
leaking test(s), repairs the leak at its source (teardown / process termination /
timer cleanup), and verifies each group exits cleanly within budget.

---

## Problem Frame

- **Authoritative signal:** CI, not a local run. Reference run `27893078004`
  (`gh run view 27893078004`), jobs: `Test shard 1/4`, `2/4`, `4/4` failed; `3/4`,
  `Engine slow tier`, `Dashboard curated-gate guard` passed.
- **Symptom:** vitest process for a group keeps emitting work (git worktree ops)
  and the watchdog `still running` heartbeat, never reaching its `Test Files …`
  summary line, until SIGTERM/SIGKILL at budget. A killed group exits non-zero →
  the shard fails → the Full Suite workflow fails.
- **Why it matters:** Full Suite is the broadest regression net. While marked
  "non-blocking," a permanently-red suite means real regressions in engine/core
  can land unnoticed. The two known pre-existing
  `shared-branch-group-entry-points.test.ts` failures (see memory) may be related
  but are a separate, smaller issue — this plan targets the *hang*.
- **Not in scope:** the `pi-claude-cli`/`droid-cli` "Failed to parse NDJSON line:
  {bad" and `packages/cli` "AI metadata generation failed; using fallback" lines —
  those are deliberate negative-path test fixtures on passing groups, not failures.

---

## Scope Boundaries

**In scope**
- Diagnose and fix whatever prevents `@fusion/engine` (both splits) and
  `@fusion/core [2/2]` from exiting within their watchdog budgets.
- Restore the Full Suite workflow to green on `main`.

**Out of scope / non-goals**
- Rewriting the CI sharding or watchdog-budget derivation logic
  (`scripts/ci-test-shard.mjs`, `scripts/lib/run-vitest-watchdog.mjs`). Only touch
  budget as a deliberate, justified last resort (see U3 / KTD-2).
- Converting Full Suite to a blocking gate.

### Deferred to Follow-Up Work
- The 2 known `shared-branch-group-entry-points.test.ts` per-task-derivation
  failures, unless reproduction shows they are the hang source.
- Broad test-suite speedups beyond what's needed to clear the budget.

---

## Key Technical Decisions

**KTD-1 — Fix the leak, do not raise the budget by default.**
The `[1/2]`/shard-3 halves prove the work fits comfortably under budget, so the
`[2/2]`/engine halves are hanging, not merely slow. Raising the watchdog budget
would mask a real open-handle leak and slow every CI run. Default posture:
identify the leaking test and repair its teardown so vitest exits cleanly.

**KTD-2 — Budget change only with evidence.**
If reproduction proves a group is *legitimately* slow (all tests complete, vitest
exits, but wall-clock genuinely exceeds budget), then and only then adjust the
group's budget/split via `scripts/ci-test-shard.mjs` timings, with the measured
numbers recorded in the commit. This is the documented exception to "don't touch
sharding."

**KTD-3 — Reproduce with the real CI invocation.**
Run the exact per-group vitest command the shard script issues (same
`--project`, same env) under a wall-clock `timeout`, plus vitest's
hanging-process reporter, so local results match CI rather than the cached
`pnpm test` changed-file path.

---

## High-Level Technical Design

```
CI shard → pnpm --filter @fusion/engine exec vitest run --project=… 
              │
              ├── all test bodies pass  ✅ (Test Files summary never printed)
              │
              └── process does NOT exit ❌
                     │  leaked handle keeps event loop alive:
                     │    • spawned git/worktree child process not awaited/killed
                     │    • setInterval / heartbeat timer not cleared in teardown
                     │    • worktree-pool / db handle not closed
                     ▼
              watchdog budget reached → SIGTERM/SIGKILL → exit≠0 → shard FAIL
```

Fix target = close the leaked handle in `afterEach`/`afterAll` (or in the
production code path the test exercises) so the process exits naturally.

---

## Implementation Units

### U1. Reproduce the hang locally and isolate the leaking test(s)

**Goal:** Turn the CI-only failure into a deterministic local repro and name the
exact test file(s) and handle that keep the process alive.

**Dependencies:** none.

**Files (investigation, no production edits yet):**
- `packages/engine/vitest.config.ts` (projects: `engine-default`,
  `engine-reliability`, `engine-core`, `engine-slow`)
- `scripts/ci-test-shard.mjs`, `scripts/lib/run-vitest-watchdog.mjs` (read-only:
  confirm the exact per-group command + budget)
- Suspect real-git/worktree tests under `packages/engine/src/__tests__/`:
  `worktree-acquisition.test.ts`, `worktree-pool-liveness.test.ts`,
  `merger-integration-worktree.test.ts`,
  `merger-finalize-unproven.real-git.test.ts`,
  `self-healing-orphan-only-scope.real-git.test.ts`,
  `self-healing-ghost-branch-recovery.test.ts`, `executor-worktree.test.ts`,
  `restart.integration.test.ts`, `run-audit.integration.test.ts`

**Approach:**
1. Derive the exact group command from `ci-test-shard.mjs` for `engine [1/2]`,
   `engine [2/2]`, and `core [2/2]`.
2. Run each under a hard wall-clock `timeout` (e.g. 420s) with hanging-process
   detection — vitest `--reporter=hanging-process` (or `--reporter=verbose
   --no-file-parallelism` plus `why-is-node-running`-style logging) to print the
   handles still open after the run finishes.
3. Confirm the signature: "Test Files … passed" never prints (or prints but
   process doesn't exit) and the reporter names the dangling handle/test file.
4. Record the offending file(s) + handle type for U2.

**Execution note:** Characterization-first — establish the failing repro and
capture the open-handle report *before* changing any production or test code.
Respect existing guards: do not kill the live dashboard port (port-4040 guards,
`FUSION_RESERVED_PORTS`) and do not kill the running dev instance.

**Test scenarios:** Test expectation: none — this unit is diagnostic; it produces
a repro recipe and a named culprit, not new tests.

**Verification:** A documented command that reliably hangs/leaks locally, and a
hanging-process report naming the test file(s) and handle keeping the loop alive.

---

### U2. Fix the leaked handle so the group exits cleanly

**Goal:** Eliminate the dangling handle so vitest exits on its own for all three
groups, with zero behavior change to the code under test.

**Dependencies:** U1.

**Files:** the test file(s) and/or production module(s) identified in U1.
Likely candidates (confirm in U1, do not assume): worktree-pool / git child
process spawn sites and their `afterEach`/`afterAll` teardown; any
`setInterval`/heartbeat timer (e.g. liveness/heartbeat code) not cleared on
teardown; db/sqlite handles left open.

**Approach (apply whichever U1 proves):**
- Await and/or terminate spawned git/worktree child processes in teardown; ensure
  no detached process outlives the test.
- Clear timers/intervals registered by the code under test (use fake timers or an
  explicit `clearInterval` in teardown).
- Close pools/db handles opened by the test.
- Prefer fixing the leak at the production source if the same handle could leak in
  real runtime; otherwise fix the test's teardown.

**Patterns to follow:** Mirror teardown patterns in the engine `[1/2]`/core
`[1/2]` tests that already exit cleanly. Reuse existing temp-dir/worktree cleanup
helpers in `packages/engine/src/__tests__/`.

**Test scenarios:**
- Happy path: the previously-hanging test still asserts its original behavior and
  passes.
- Resource cleanup: after the test, the hanging-process reporter shows **no**
  dangling handle for the fixed file (regression guard against re-introduction).
- Edge: if a child process is killed in teardown, a test where the process already
  exited does not throw on double-kill.

**Verification:** Each group runs to its `Test Files … passed` summary AND the
process exits 0 without watchdog intervention.

---

### U3. Verify all three groups finish within budget and Full Suite goes green

**Goal:** Confirm the fix across `engine [1/2]`, `engine [2/2]`, and
`core [2/2]`, and that the workflow passes end-to-end.

**Dependencies:** U2.

**Files:** none (verification). Only touch `scripts/ci-test-shard.mjs` timings if
KTD-2's slow-not-hung condition is proven in U1/U2.

**Approach:**
1. Re-run each group's exact command under the same wall-clock `timeout`; confirm
   each exits 0 comfortably under its watchdog budget (405s / 405s / 338s).
2. Push the branch (or trigger the Full Suite via `workflow_dispatch`) and watch
   the four shards go green via `gh pr checks --watch` / `gh run watch`.
3. If a group is proven slow-not-hung, apply the KTD-2 budget/split adjustment
   with measured numbers in the commit message.

**Test scenarios:** Test expectation: none — verification unit.

**Verification:** Full Suite (non-blocking) run on the branch reports all shards
`success`; no group is SIGKILLed at budget.

---

## Risks & Dependencies

- **Repro may be environment-sensitive.** If the hang is CI-specific (e.g. git
  identity, worktree path layout, missing TTY), local repro in U1 may not trigger
  it. Mitigation: replicate CI env vars from the shard script; if still not
  reproducible, drive the diagnosis from a `workflow_dispatch` run with the
  hanging-process reporter enabled and artifacts uploaded.
- **vitest auto-kill history (memory):** older fn TUI builds SIGKILLed `vitest`
  processes every 30s. Ensure the TUI is not running the broken build during
  local repro, or run the repro outside the TUI, so a clean exit isn't mistaken
  for a kill.
- **Multiple independent leaks.** engine `[1/2]` and `[2/2]` both failing may mean
  more than one leaking test; treat U1/U2 as iterative until all three groups are
  green.

## Sources & Research

- CI run `27893078004` (jobs + full log) — failure signature, watchdog budgets,
  per-group heartbeat counts.
- `gh run list --branch main --workflow "Full Suite (non-blocking)"` — 30+
  consecutive failures (chronic, not a fresh regression).
- `packages/engine/vitest.config.ts` — 30s testTimeout, 45s hookTimeout, project
  splits.
- Memory: "Branch-group known failures", "vitest auto-kill incident",
  "Port 4040 kill guards", "Engine src has no tsc emit".
