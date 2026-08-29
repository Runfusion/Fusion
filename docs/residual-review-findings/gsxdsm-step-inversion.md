# Residual Review Findings — `gsxdsm/step-inversion`

Source: `ce-code-review mode:autofix` run `20260604-132117-b1269bcd` (12 reviewers) against merge-base `d0b5dcbf`, plan `docs/plans/2026-06-04-001-feat-step-inversion-workflow-modelable-steps-plan.md`. 17 findings were fixed and committed (`3ebaa321f`); the items below remain as tracked residual work.

## Residual Review Findings

- [P1] `packages/engine/src/executor.ts:3945` — **Per-instance worktree isolation is commit-cosmetic**: the memoized single implementation pass runs in the MAIN worktree; instance branches receive no per-step commits, so parallel-mode integration rebases empty branches. Requires a per-step `StepSessionExecutor` scoped to `active.worktreePath`. Bookkeeping (rows/worktrees/budgets/ordering) is correct and tested; write-isolation is not yet real. Flag-gated experimental path only.
- [P2] `packages/engine/src/self-healing.ts` — Stale step-instance self-healing sweep (the `recoverStaleTransitionPending` analogue) not implemented; in-progress rows on never-re-dispatched tasks orphan forever (per-run resume seeding exists).
- [P2] `packages/engine/src/plugin-parser-adapter.ts:105` — Plugin parser timeout is post-call, not pre-emptive; a runaway synchronous parser blocks the event loop.
- [P2] `packages/engine/src/workflow-graph-foreach.ts:605` — Integration-conflict retries and reviewer rework share one `maxReworkCycles` budget; repeated conflicts can exhaust it before any REVISE runs.
- [P2] `packages/engine/src/__tests__/stepwise-workflow-parity.test.ts` — Parity oracle is a hand-written legacy simulator, not the real `StepSessionExecutor`; fidelity should be cross-checked against the step-session characterization suite.
- [P2] Test gaps: pin-mismatch grow/shrink on resume; plugin-parser timeout path; explicit `outcome:integration-conflict` edge override; `step-review type:"plan"` via the graph handler; code-node child env-restriction regression; TUI field-chip render.
- [P3] `packages/engine/src/code-node-runner.ts:316` — Temp-dir sweep for parent-crash leftovers (`fusion-code-node-*`).
- [P3] `packages/engine/src/code-node-runner.ts:245` — Compile cache keyed on source hash (N× esbuild spawns per foreach).
- [P3] `packages/engine/src/executor.ts` — Store-capability `as unknown as` casts → optional-capability interface.
- [P3] `packages/core/src/index.ts:127` — `__resetStepParserRegistryForTests` exported on the public barrel; consider a test-support entry point.
- [P3] Agent/dashboard read surface for step-instance state (rework counts, verdicts) — parity debt for when the dashboard surfaces it.
