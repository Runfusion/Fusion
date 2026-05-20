---
"@runfusion/fusion": patch
---

Fix Fusion pre-commit identity-guard hook leaking install-time task ID across shared git hooks dir; hook is now driven entirely by per-worktree fusion-task-id metadata (lowercased to match canonicalFusionBranchName), so a stale install no longer refuses valid sibling-worktree commits.
