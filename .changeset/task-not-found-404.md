---
"@runfusion/fusion": patch
---

summary: Task API endpoints now return 404 for an unknown task id instead of a 500 error.
category: fix
dev: New typed `TaskNotFoundError` + `isTaskNotFoundError` guard in `@fusion/core` (`task-store/errors.ts`), thrown by both branches of `getTaskImpl` and the delete paths with a byte-identical `Task ${id} not found` message. Dashboard routes map it through the shared `packages/dashboard/src/routes/task-lookup-error.ts` helpers (`isTaskLookupMiss`, `taskLookupStatus`, `rethrowTaskApiError`); the legacy ENOENT check is retained as a fallback.
