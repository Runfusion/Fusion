---
"@runfusion/fusion": patch
---

Dispose completed spawned child agent sessions so execution memory is released promptly after `fn_spawn_agent` children finish, keep artifact registry listing metadata-only so large inline artifacts are not loaded during agent execution, bound structured tool-result log previews before serialization, reduce dashboard SSE keepalive churn, and keep the dashboard TUI performance timeline drained during long-running execution.
