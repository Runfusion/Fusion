---
"@runfusion/fusion": patch
---

summary: Fix Mailbox artifact messages — "Open artifact" now loads without an auth error and "View task" opens the task.
category: fix
dev: artifactMediaUrl now appends the fn_token query fallback for authenticated element/link loads (script-capable HTML artifact iframes stay token-free); isTaskPopupVisibleForView no longer gates non-board/list popup opens and usePoppedOutTasks.popOut upgrades same-id entries.
