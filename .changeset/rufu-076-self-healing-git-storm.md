---
"@runfusion/fusion": patch
---

summary: Stop periodic self-healing git churn on paused projects and bound repair sweeps so health/UI stay fast.
category: performance
dev: SelfHealingManager no longer arms its periodic-maintenance setInterval when the project is paused (globalPause/enginePaused), and clears it on a pause transition, re-arming on unpause — so `git worktree prune` / `git worktree list --porcelain` / `git branch --list 'fusion/*'` no longer fire every maintenance cycle on paused projects (the production git storm behind 61-70% engine CPU). Batch-1 git-churn steps are demoted to at-most-hourly on active projects via a coarse-cadence gate, and `recoverDoneTaskMergeMetadata` is capped at 25 candidates/cycle (was O(done_tasks) x git per cycle). Pure-DB/FS housekeeping (task-lifecycle retention, GitHub check-state retention, symbol-lock reconcile, WAL checkpoint, operational/agent-log prune) still runs on the fast cadence under pause.