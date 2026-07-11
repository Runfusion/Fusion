---
"@runfusion/fusion": minor
---

summary: Artifacts view — select text in a Task Document's content pane to comment and send it to a new task.
category: feature
dev: DocumentsView Task Documents right pane reuses the Project Files `useSelectionComment`/`SelectionCommentPopover` pattern (markdown + plain refs following the render toggle, composer-open lock, popover gated on the task-document selection + `onSendSelectionToTask`). Project Files behavior and the markdown/plain toggle are unchanged. Depends on FN-7811.
