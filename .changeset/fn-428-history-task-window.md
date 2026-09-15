---
"@runfusion/fusion": patch
---

summary: Opening a task from History no longer covers the screen with a blocking overlay.
category: fix
dev: History entry activation now routes through the shared `openTaskDetailInWindow` owner (`getCoexistingTaskOpenRoute`) so it opens a coexisting task window instead of the modal `TaskDetailModal` presentation; mobile still uses the main panel.
