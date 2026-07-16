---
"@runfusion/fusion": patch
---

summary: Fix tasks stalling when a leftover git branch collided with a new worktree.
category: fix
dev: NativeWorktreeBackend.create now runs a collision-specific classifier that reconciles a bare "branch already exists" collision (reuse reclaimable branches, recreate merged/orphaned branches from the pinned start point) instead of re-throwing; unmerged foreign/unattributed branches are preserved and live-foreign branches still raise BranchConflictError.
