---
"@runfusion/fusion": patch
---

summary: Stop failing tasks over a stale worktree base — refreshing the base no longer blocks execution.
category: fix
dev: `refreshReusedWorktreeBase` now returns `executionSafe: true` with `skipped: true` for dirty checkouts, own-commit rebase conflicts, unresolvable bases, and compensated persistence failures; only an unproven tree (failed compensation) still throws `WorktreeBaseRefreshError`. The dirty-tree check moved after the up-to-date check so a worktree already on the current base is never refused. `execute()` now catches the residual throw and routes it into the shared bounded non-parking hold (`holdForWorktreeBaseRefresh`), which the graph-failure lane also uses. New git run-audit type `worktree:base-refresh-skipped` separates a declined refresh from a genuine block.
