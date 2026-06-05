---
date: 2026-06-04
topic: fast-trusted-test-gate
---

# Fast, Trusted Test Gate

## Summary

Shrink the PR merge gate to a minimal trusted set — typecheck, build, boot smoke, and a small curated core-engine suite — demote everything else to non-blocking, and install a deletion ratchet: flaky tests are quarantined on sight and deleted after 2 weeks unless rescued with evidence. De-duplicate the overlapping shard runs across CI workflows.

---

## Problem Frame

PRs currently trigger multiple test shard jobs at 4–10 minutes each, and the suite appears to run in both `.github/workflows/ci.yml` (3 shards) and `.github/workflows/pr-checks.yml` (4 shards). Failures are mostly flaky/infra — timeouts, port conflicts, OOM kills — not real bugs. Local developers hit OOM running tests.

The cost is severe: roughly 70% of shipping time goes into a loop of asking an agent to fix the failure and re-running. The agent-fix loop has a known degradation mode — agents appease flaky tests (widen timeouts, add retries, loosen assertions) rather than fix root causes, draining whatever signal the tests had.

Against that cost, the suite's recalled value is zero: no PR test failure in recent memory caught a bug that would have actually broken users. ~3,880 test files are currently pure cost. Substantial speed infrastructure already exists on this branch (affected-only runner with content-hash caching in `scripts/test-changed.mjs`, CI sharding, a `.slow` split, isolation checks) — speed tuning alone has not fixed the problem because the core issue is trust, not throughput.

---

## Key Decisions

- **Thin trusted gate over broad coverage.** The merge gate guarantees only what the maintainer needs to merge without anxiety: typecheck, build, boot smoke, core-engine correctness. The evidence (zero recalled real catches across ~3,880 files) says breadth was not buying protection.
- **Delete over quarantine-forever.** Quarantine is a 2-week waiting room, not a retirement home. Without a deletion deadline, the demoted suite rots into a permanently red zombie that still consumes attention.
- **Policy, not machinery.** The ratchet is a written rule (in `AGENTS.md` and contributor docs), not new test infrastructure. This repo's history shows a pattern of answering test pain with more test machinery (sharding, isolation checks, lock runners, kill guards); this change deliberately breaks that pattern.
- **Agents are banned from "fixing" flaky tests.** When an agent encounters a flaky test, the correct action is quarantine, never appeasement. This stops the suite-weakening loop.
- **Reuse existing infrastructure.** `scripts/test-changed.mjs`, the `.slow` split, and shard timing artifacts stay. The change is what blocks merges, not how tests run.

---

## Requirements

**Merge gate**

- R1. The PR merge gate consists of: typecheck, build, a boot smoke check (the app starts and serves), and a curated core-engine test suite.
- R2. The curated core-engine suite runs as a single CI job targeting under ~3 minutes, with zero known-flaky tests admitted.
- R3. The gate is the only merge-blocking test signal; no other test job can block a PR.
- R4. If no suitable boot smoke check exists, a single small one is created (see Dependencies).

**CI de-duplication**

- R5. The full suite runs at most once per PR event; the overlapping shard runs between `.github/workflows/ci.yml` and `.github/workflows/pr-checks.yml` are consolidated.
- R6. Tests outside the gate run as a non-blocking job (post-merge or scheduled); their failures never block a PR.

**Deletion ratchet (policy)**

- R7. Any test observed to fail without a corresponding real bug (flake) is quarantined on sight — removed from all blocking and non-blocking runs, not retried, not patched.
- R8. A quarantined test is deleted after 2 weeks unless someone rescues it with evidence that it catches real regressions; rescue requires fixing the flake at the root, not appeasing it.
- R9. The quarantine/delete rule and the agent prohibition on flaky-test appeasement (no widened timeouts, added retries, or loosened assertions to make a flake pass) are written into `AGENTS.md`.
- R10. Admission to the blocking gate requires evidence of value; tests do not graduate into the gate by default.

**Local development**

- R11. The default local test command (`pnpm test`) runs the gate suite, sized so it cannot OOM a typical dev machine.
- R12. Running anything larger locally is opt-in via explicitly named commands.

---

## Acceptance Examples

- AE1. **Covers R7, R8.**
  - **Given:** a test fails on a PR, and the failure does not correspond to a bug in the change.
  - **When:** a maintainer or agent triages it.
  - **Then:** the test is quarantined (skipped everywhere) in that same PR or a follow-up, with a dated marker; 2 weeks later it is deleted unless rescued with evidence.
- AE2. **Covers R3, R6.**
  - **Given:** a non-gate test fails in the non-blocking run.
  - **When:** a PR is open.
  - **Then:** the PR's mergeability is unaffected; the failure surfaces as information only.
- AE3. **Covers R9.**
  - **Given:** an agent is asked to deal with a red flaky test.
  - **When:** it consults `AGENTS.md`.
  - **Then:** it quarantines the test rather than widening timeouts, adding retries, or weakening assertions.

---

## Success Criteria

- PR wall-clock for required checks drops from tens of minutes to under ~5 minutes.
- Maintainer time spent on the fix-and-rerun loop drops from ~70% to near zero; a red gate reliably indicates a real problem.
- No local OOMs from the default test command.
- Suite size shrinks over time via the ratchet rather than growing unboundedly.

---

## Scope Boundaries

- No new test machinery: no auto-quarantine infrastructure, no flake-scoring system, no test-value telemetry (the Approach C ratchet automation was considered and rejected as more of the machinery pattern).
- No root-cause fixing of existing flaky tests as part of this work — flakes exit via quarantine and deletion.
- Healthy non-gate tests survive indefinitely in the non-blocking run; this work does not mass-delete tests that aren't flaky.
- Coverage targets and coverage tooling are untouched.

---

## Dependencies / Assumptions

- **Unverified:** whether a usable boot smoke test already exists. If not, R4 creates one — kept deliberately small.
- **Unverified:** the exact trigger overlap between `ci.yml` and `pr-checks.yml` shard jobs on PR events; confirmed shard matrices exist in both, but trigger conditions need checking during planning.
- The existing `.slow` split and `scripts/test-changed.mjs` remain the mechanism for selecting and running tests; this work changes gating, not the runner.
- Branch protection / required-checks settings are adjustable to match the new gate.

---

## Outstanding Questions

**Deferred to planning**

- Which engine tests make the curated gate suite (selection criteria: deterministic, fast, covering core orchestration logic the maintainer actually relies on).
- Quarantine mechanics: skip annotation vs. exclusion list vs. moving files — whichever is cheapest with the existing runner.
- Where the non-blocking run lives (post-merge on main vs. scheduled) and how its results surface without demanding attention.
