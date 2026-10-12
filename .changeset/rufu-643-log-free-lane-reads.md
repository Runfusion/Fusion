---
"@runfusion/fusion": patch
---

summary: Drop the unused task-log column from four more recurring engine reads, easing the memory ramp.
category: fix
dev: `excludeLog: true` now applies to the scheduler's two dependent-reconciliation lane reads (both blockers and deleted-blocker sibling), the backlog-pressure reporter's board + lane reads, and the self-healing deleted-task worktree pass. Each was proven marker-free at the call site, not just in its helpers — `stale-task-reporter` was audited and REJECTED because it pattern-matches `STALE_LOG_RE` over `task.log` itself. No badge changes: the five log-derived figures are answered from `timing_total_ms` + `log_recent` (RUFU-615).
