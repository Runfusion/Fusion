---
"@runfusion/fusion": minor
---

summary: Cmd/Ctrl+Enter now creates and starts a task in Quick Add and the New Task dialog.
category: feature
dev: The shortcut routes to the existing Start paths (QuickEntryBox `handleStartClick`, NewTaskModal `handleStartSubmit` via TaskForm's create-mode description key handler) and falls back to create-only when the selected workflow is not Start-eligible. Plain Enter and Shift+Enter behavior is unchanged.
