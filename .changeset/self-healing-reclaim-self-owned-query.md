---
"@runfusion/fusion": patch
---

summary: Self-owned branch conflicts are now reclaimed on boards with renamed columns.
category: fix
dev: `reclaimSelfOwnedBranchConflicts` read the literal `todo`/`in-progress`/`in-review` and kept three lane guards on column ids, so a task whose own worktree held its own branch stayed wedged on a renamed board. Reads resolve via `resolveProjectColumnsForRoles` and the three guards resolve per card; the `recoveryRehome` re-home keeps its legacy target by design.
