---
"@runfusion/fusion": patch
---

Make self-healing maintenance respect worktrunk-managed layouts by deferring native prune/orphan cleanup/worktree-cap sweeps to the active worktrunk backend when enabled, while keeping branch-level reclaim logic unchanged.
