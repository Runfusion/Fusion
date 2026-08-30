---
"@runfusion/fusion": major
---

summary: Prevent unplanned tasks from being force-started into execution.
category: breaking
dev: Removes the promoteHeldTask force option, issueRelease allowUnplanned option, POST /tasks/:id/promote force body field and forceable hint, fn_task_promote force parameter, task:promote-forced-unplanned audit event, and column.promoteUnplannedTitle, column.promoteUnplannedMessage, column.promoteUnplannedConfirm, and column.promoteUnplannedCancel i18n keys.
