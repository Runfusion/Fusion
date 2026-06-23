---
"@runfusion/fusion": patch
---

Dispose completed spawned child agent sessions so execution memory is released promptly after `fn_spawn_agent` children finish, and keep artifact registry listing metadata-only so large inline artifacts are not loaded during agent execution.
