---
"@runfusion/fusion": patch
---

summary: Keep a task's live worktree through in-review branch rebinds instead of losing it to the idle sweep.
category: fix
dev: "`task:auto-rebind-applied` now records `preservedWorktree`; adds the reliability-lane worktree lifecycle certification suite."
