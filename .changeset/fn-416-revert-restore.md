---
"@runfusion/fusion": minor
---

summary: A reverted task now shows only its Reverted badge, and the context menu can restore the revert.
category: feature
dev: Removes the card's `.card-reverted-actions` Delete/Revise strip, the `tasks.revertedResolutionActions` key, and the whole `onReviseTask` prop chain (App, AppModals, MainContent, MainViewKeepAlive, Board, Column, Lane, WorktreeGroup, DockTaskList, right-dock, ListView, TaskDetailModal). Adds `POST /tasks/:id/revert/restore` backed by engine `performTaskRevertRestore`, an additive `sourceMetadata.restoredAt` marker consumed by `isTaskReverted` (no migration, `revertedAt` preserved), and a `createAiRestoreTask` conflict fallback keyed on `restoreOf` delivered by the AI merge pipeline.
