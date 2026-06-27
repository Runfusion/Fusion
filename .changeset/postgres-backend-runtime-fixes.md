---
"@runfusion/fusion": patch
---

summary: Fix PostgreSQL-mode crashes — agent-log flush no longer kills the server, and Command Center activity loads.
category: fix
dev: The agent-log buffer flush/append path (flushAgentLogBufferImpl, appendAgentLogBatchImpl, appendAgentLogImpl) dereferenced the SQLite-only `store.db` getter — which throws in PG backend mode — on an unref'd retry-timer and inside catch handlers, so a handled flush error became an uncaught exception that exited `fn serve` (~35s uptime). Guarded the deleted-task pre-filter and `bumpLastModified` with `!store.backendMode` and replaced every `store.db.path` log interpolation with the mode-safe `store.fusionDir`. Also schema-qualified raw async SQL that referenced project-schema tables unqualified / with camelCase columns: `project.deployments` + `project.incidents` with snake_case `deployed_at`/`opened_at`/`resolved_at` (the deployments read sat outside the try/catch and 500'd `/api/command-center/activity`), `project.experiment_session_records` (+ `::jsonb` cast on the payload update), and `project.agent_runs`. Adds a backend-mode regression test pinning the no-`store.db`-deref invariant across all three agent-log entry points.
