---
"@runfusion/fusion": minor
---

summary: Add an AI-undo fallback task when reverting a done task via git conflicts or is unsupported.
category: feature
dev: `POST /api/tasks/:id/revert` now accepts `{ mode?: "git" | "ai" | "auto" }` (default `"auto"`). `"auto"` tries the FN-7523 git-revert path first and falls back to creating an AI-undo board task (`{ mode: "ai", createdTaskId, alreadyOpen? }`) on a conflicting or unsupported (e.g. workspace) git result; `needsHuman` (autoMerge-off) never triggers the fallback. `"ai"` always creates the AI-undo task; `"git"` keeps the FN-7523 git-only contract, which is otherwise unchanged. New engine exports: `createAiUndoTask`, `buildAiUndoTaskDescription`, `REVERT_OF_METADATA_KEY`. New core store method `TaskStore.findOpenRevertTaskForSource` backs the idempotency guard (an open undo task suppresses a duplicate; a closed one does not).
