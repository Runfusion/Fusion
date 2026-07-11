---
"@runfusion/fusion": patch
---

summary: Server now logs the underlying stack behind an API 500 so opaque task-endpoint failures are diagnosable.
category: fix
dev: `rethrowAsApiError` (packages/dashboard/src/api-error.ts) now preserves the original error as Error `cause` instead of discarding it, and `sendErrorResponse`/the `/api` error boundary (packages/dashboard/src/server.ts) log the stack + cause chain for 5xx (not just the message). The client-facing body stays generic in production. Unblocks root-causing the reported "task write API returns 500 for every task" (GET/DELETE/PATCH/retry/archive/reset on /api/tasks/:id) whose cause was previously never recorded server-side.
