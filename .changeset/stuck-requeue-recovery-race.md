---
"@runfusion/fusion": patch
---

Fix a race in the stuck-task requeue path that could clobber a task back to
`todo` (with all step progress reset and worktree torn down) immediately
after `SelfHealingManager.recoverCompletedTasks` had already moved it to
`in-review`. The executor's stuck-kill cleanup ran in `execute()`'s
`finally` block and used a stale captured `task.column` snapshot, so it
would happily overwrite a fresh recovery. The cleanup now re-reads the
latest column and skips entirely when the task has moved past
`in-progress`/`todo`.

Also adds a new setting `preserveProgressOnStuckRequeue` (default: `true`,
toggle in Settings → Engine, near "Stuck Task Timeout"). When enabled, the
stuck detector's requeue passes `{ preserveProgress: true }` to `moveTask`
so completed step statuses survive the bounce and the agent can resume
from where it left off instead of restarting every step from pending.
