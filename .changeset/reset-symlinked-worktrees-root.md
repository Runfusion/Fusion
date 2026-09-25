---
"@runfusion/fusion": patch
---

summary: Reset now works when the task worktrees root sits under a symlink.
category: fix
dev: Reset's containment and ownership guards compared a `realpath`-resolved path against a `resolve()`-only one, so a symlinked worktrees root (every macOS temp path, any symlinked volume) refused with "unsafe worktree path outside the configured worktree root" or "ownership cannot be proven". Both guards normalize each side and stay fail-closed; foreign and unregistered paths still refuse.
