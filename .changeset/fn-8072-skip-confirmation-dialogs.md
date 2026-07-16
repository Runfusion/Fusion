---
"@runfusion/fusion": minor
---

summary: Add a global option to skip confirmation dialogs for critical actions.
category: feature
dev: New global setting `skipConfirmationDialogs` (default false); when on, `ConfirmDialogProvider` resolves confirm/confirmWithChoice/confirmWithCheckbox to the primary/default choice without rendering the dialog. Toggle in Settings → Global → General. Reset-task guards in TaskCard/TaskDetailModal/ListView migrated to the useConfirm seam.
