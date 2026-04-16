---
"@gsxdsm/fusion": patch
---

Auto-delete ephemeral agents from the agents page. Task-worker agents (created by InProcessRuntime) and spawned child agents (created by TaskExecutor) are now auto-deleted after termination. The agents page hides system agents by default with a toggle to show them.
