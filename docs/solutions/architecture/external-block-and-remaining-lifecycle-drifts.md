---
category: architecture
module: Task lifecycle
tags:
  - external-block
  - self-healing
  - worktrees
  - workflow-review
problem_type: architecture-decision
applies_when: A task stops because infrastructure outside its worktree is unavailable and must resume without losing committed work.
---

# External blocks and remaining lifecycle drifts

## Decision

An obstacle outside a task worktree becomes durable `blocked` state only when the shared classifier recognizes a conservative host-resource, network, model-provider, or credential cause. A classified block is not failure, replan, or operator pause: the task retains its column, step state, worktree, branch, capacity slot, and file-scope lease, while Dashboard Retry clears only the block and resumes the recorded workflow node.

FN-243 corrected the broader agent-declaration route: `outside-worktree` alone no longer authorizes a freeze. An unclassified cause is returned to the executor without lifecycle mutation to resolve it, substitute a runnable check, or complete achievable work and record the deferred check as non-blocking. Internal defects—code, tests, type errors, merge conflicts, planning gaps, and review revisions—remain owned by the existing AI remediation paths. Dependencies and file overlap remain waiting states.

## Remaining drifts documented, not fixed by FN-209

1. **Multi-repository review stops at the first failing repository.** Location: workspace per-repository review aggregation in the engine workflow review path. Root cause: evaluation short-circuits on the first blocking verdict. Desired behavior: retain a verdict for every modified repository before selecting remediation.
2. **File-scope contention can abort an already-running execution.** Location: scheduler admission and active file-scope lease reconciliation. Root cause: a late overlap decision can be treated like dispatch refusal after work owns a session. Desired behavior: scheduling leases arbitrate before execution ownership and never cancel a valid active owner.
3. **Worktree and capacity-slot leaks need recovery.** Location: `SelfHealingManager.reapLeakedConcurrencySlots` and worktree-pool reconciliation. Root cause: process death can strand in-memory ownership without a live executor. Desired behavior: reclaim only after durable and runtime liveness proof agree the holder is gone.
4. **Plan Review replanning is unbounded.** Location: the Plan Review → replan workflow loop. Root cause: repeated revisions have no mandatory convergence ceiling. Desired behavior: a bounded budget ends in explicit human approval rather than indefinite regeneration.
5. **Concurrent recovery sweeps can issue contradictory actions.** Location: lifecycle-mutating methods in `packages/engine/src/self-healing.ts`. Root cause: independent snapshots can classify the same card before either mutation becomes visible. Desired behavior: one atomic lifecycle claim or shared generation fence decides each recovery episode.

These five items are an inventory only. FN-209 does not change their behavior.
