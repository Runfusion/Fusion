---
"@runfusion/fusion": patch
---

summary: Board lane counts and card glow now never exceed the actual number of running agents.
category: fix
dev: `isTaskAgentActive`'s positive arm now delegates to the shared `isRunningAgentTask` predicate and Column headers count only that predicate; the needs-replan REVISING chrome and fresh planner-log glow window are removed (idle replans render "Queued to revise").
