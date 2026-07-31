---
"@runfusion/fusion": patch
---

summary: PR-conflict reclaim no longer reads a busy checkout as unowned on renamed boards.
category: fix
dev: `reclaimPrConflictForTask` built its worktree-owner map from a literal `in-progress` read, so on a renamed board the map was empty and a checkout another task was live in read as unowned. Read resolves via `resolveProjectColumnsForRoles(["countsTowardWip"])`; the map is keyed by worktree path so there is no per-card lane verdict to convert.
