---
"@runfusion/fusion": patch
---

summary: Fix data stores that silently failed against PostgreSQL by hitting removed SQLite paths.
category: fix
dev: Six residual SQLite-stub sites reachable in backend mode are now routed through the AsyncDataLayer or guarded: the executor's authoritative assigned-agent fallback (executor.ts) now inherits the TaskStore asyncLayer (was silently returning null → model drift); `pruneAgentLogFilesAsync` replaces the sync self-healing prune call (was throwing every maintenance sweep); `cleanupOrphanedMaterializedSteps` deletes PG workflow_steps rows on failed create (was leaking); PG hard-delete now runs the async mission feature/task-link unlink (deleteTaskBackendImpl); `getWorkflowSettingsProjectId` no longer touches the SQLite stub for unscoped backend stores; the `fn plugin` unregistered-project fallback bootstraps a CentralCore AsyncDataLayer. Dead legacy paths (cleanupArchivedTasks, deleteWorkflowStep, applyTaskPatch, AgentStore.importLegacyFileRuns) now guard backend mode with clear errors / clean no-op instead of the cryptic removed-SQLite throw.
