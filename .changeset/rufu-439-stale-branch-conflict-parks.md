---
"@runfusion/fusion": patch
---

summary: Stale branch-conflict alarm badges on finished cards are now cleared automatically.
category: fix
dev: New self-healing sweep `reconcileTerminalBranchConflictParks()` (registered in startup recovery and maintenance batch 1) reads the terminal lane only, re-proves from live git that neither the task branch nor a registered worktree for it exists, and clears `pausedReason=branch-conflict-unrecoverable` in place — recording the `task:reconcile-terminal-branch-conflict-park` audit event with outcome `stale-park-cleared` plus one task-history line. It never writes a column, so `done` stays terminal; a live branch ref, a registered worktree, an operator pause, another pause reason, a non-terminal lane, or an unreadable repository leaves the card byte-identical.
