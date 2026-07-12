---
"@runfusion/fusion": patch
---

summary: Task API operations no longer fail with 500 when a task's PROMPT.md can't be read; server also logs 500 causes.
category: fix
dev: getTask (the shared load for GET/DELETE/PATCH/retry/reset/archive) and the mutation helpers updateTaskUnlocked, updateStep, readPromptForArchive, and resetPromptCheckboxes (packages/core/src/store.ts) read PROMPT.md unguarded, so an unreadable file (root-owned from a prior `sudo` run → EACCES, PROMPT.md being a directory → EISDIR, transient FS error) 500'd every per-task op while the PROMPT.md-free board list/create kept working. These reads are now best-effort (degrade + log). Diagnosability: rethrowAsApiError preserves the original error as Error `cause` and the /api boundary logs stack + cause for 5xx (packages/dashboard/src/api-error.ts, server.ts); client body stays generic in production.
