---
"@runfusion/fusion": patch
---

Engine reliability: fn_task_done now rejects completion when the executor session is not running in the task worktree/branch or has zero commits beyond base, and worktree liveness is asserted before session start. Both failure modes route through the existing auto-retry path so the task returns to todo instead of producing a ghost completion.
