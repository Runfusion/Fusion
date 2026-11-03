---
"@runfusion/fusion": minor
---

summary: Approved zero-commit cards now finish on their own instead of wedging in review forever.
category: feature
dev: New `SelfHealingManager` reconcile outcome `zero-commit-discharged` (a success on `fn task reconcile` and the dashboard reconcile route) and guard source `self-healing-reconcile-commit-free`; `evaluatePreMergeApprovals` now reads `task.noCommitsExpected` off the row, so `getTaskHardMergeBlocker`'s fixed option whitelist needs no widening. The waiver fires only for the `missing-worktree-or-base` diff reason — an unavailable diff reported as `git-diff-too-large` or `git-diff-failed` proves content exists or may exist and still refuses.
