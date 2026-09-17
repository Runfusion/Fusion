---
"@runfusion/fusion": minor
---

summary: Chat returns to the right dock, dialogs stay on top, and task windows follow you across views.
category: breaking
dev: Removes the `taskPopupsBoardListOnly` project setting and its Appearance toggle, search entry, and locale keys; task-window identity is now the task id alone (`originTaskView` deleted). Historical stored values are ignored and never rewritten — no migration runs. Chat is an inline non-expandable right-dock tool again; shared Alpha dialogs portal to `document.body` and claim the shared floating layer.
