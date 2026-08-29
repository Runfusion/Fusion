---
"@runfusion/fusion": patch
---

summary: Fix Start in the task composer doing nothing on a duplicated Ideas workflow.
category: fix
dev: `resolveQuickAddStartInitialColumn` no longer keys on the literal `builtin:coding-ideas` id — a manual-intake workflow now resolves its create-time Planning lane from traits (first declared `hold` column immediately after the intake), mirroring `resolveWorkflowIntakeFacts`'s unplanned-Start classification in `packages/core/src/task-store/task-creation.ts`. `resolveQuickAddStartTargetColumn` promotes exactly one legal forward step (hold lanes included) instead of skipping holds into the WIP lane, which column adjacency always rejected (`intake -> hold | archived`). Covers both Start surfaces: QuickEntryBox and NewTaskModal.
