---
"@runfusion/fusion": patch
---

summary: Add an intelligent git-revert engine service and POST /api/tasks/:id/revert route.
category: feature
dev: New `packages/engine/src/task-revert.ts` exports `resolveTaskRevertCommits`, `classifyTaskRevert`, and `performTaskRevert` (squash/rebase/lineage attribution precedence, dry-run classification, guaranteed-clean rollback). Route enforces done/archived-only and autoMerge-off guard rails; conflicting results are returned unresolved for sibling FN-7524 (AI-undo) to act on. Workspace tasks return `unsupported`.
