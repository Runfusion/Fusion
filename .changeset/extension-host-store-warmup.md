---
"@runfusion/fusion": patch
---

summary: Warm extension-host task stores up front so fn_task_* tools never hit a lazy second-pool boot.
category: fix
dev: Populates setHostTaskStore for every registered project from the already-running ProjectEngine TaskStores at dashboard startup, so extension API tools (fn_task_update, fn_task_archive, fn_agent_show) find a cached store and never fall through to createTaskStoreForBackend, which could time out creating a second connection pool. cwd is skipped because its store is already injected. Non-fatal warnings on any per-project failure.