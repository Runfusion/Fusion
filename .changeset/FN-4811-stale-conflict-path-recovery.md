---
"@runfusion/fusion": patch
---

fix(FN-4811): recover from "validation failed, cannot remove working tree" + collapse broken FN-4806 nested branches

Two follow-ups stacked on the FN-4811 active-worktree liveness gate:

1. **Stale conflict-path recovery (was breaking real tasks).** When `git worktree remove --force` fails with `fatal: validation failed, cannot remove working tree`, the worktree directory is missing on disk and the git admin entry is stale. `cleanupConflictingWorktree` now catches that specific error, runs `git worktree prune`, best-effort deletes the branch, and returns success — so the caller can proceed with worktree creation instead of failing 3× with "automatic cleanup failed" (FN-4813 production failure).

2. **Collapsed broken FN-4806 nested branches.** The previous FN-4806 refactor accidentally nested the genuine "agent finished without calling fn_task_done" failure path inside the silent-recovery branch, so ordinary failures were being silently requeued instead of marked failed. Restored the clean two-branch structure: `else if (retryAbortedDueToReclaim)` silent-recovers, `else` marks failed/onError/burns budget. Also clears `baseCommitSha` on silent recovery (matches the parallel session-start-failure path).
