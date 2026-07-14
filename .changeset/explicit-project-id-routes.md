---
"@runfusion/fusion": patch
---

summary: Dashboard API requests now resolve an explicit registered project instead of silently using the launch directory.
category: fix
dev: routes/context.ts gains a shared resolveRequestProjectId/getScopedStore/getProjectContext seam (request projectId → options.engine.getProjectId() → raw launch-dir store with a one-time warn, for unregistered dirs only). A resolved id always binds through the engine store or getOrCreateProjectStore; the launch project reuses the injected registry-bound store to avoid a duplicate pool. server.ts resolveScopedStore threads the launch project id, and the todo/goals/mission/insights/research/evals routers route their request middleware through the same seam.
