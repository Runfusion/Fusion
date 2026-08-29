---
"@runfusion/fusion": minor
---

summary: Executing agents no longer create tasks; out-of-scope findings become completion recommendations.
category: breaking
dev: Withholds fn_task_create/fn_delegate_task by task-execution lane, marks sessions with taskExecutionSession, refuses extension calls with task-execution-cannot-create-tasks, and rejects SELF_SPAWNED_DEPENDENCY edges.
