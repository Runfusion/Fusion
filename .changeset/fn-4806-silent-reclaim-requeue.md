---
"@runfusion/fusion": patch
---

Engine: worktree/branch reclaim during the no-fn_task_done retry loop now silently requeues to `todo` instead of surfacing a `failed` task. Genuine retry exhaustion still fails and counts against the retry cap.
