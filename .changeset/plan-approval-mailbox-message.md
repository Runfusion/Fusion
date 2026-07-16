---
"@runfusion/fusion": minor
---

summary: Plans that need approval now also post a task-linked message to your dashboard mailbox.
category: feature
dev: NotificationService.handleTaskUpdated writes a `system`-typed mailbox message via `MessageStore.sendMessageOnce` (idempotency key `plan-approval:<taskId>`) on the awaiting-approval transition, alongside the existing ntfy push. Content links to the task using `buildNtfyClickUrl(ntfyDashboardHost, projectId, taskId)`; `system` type avoids re-triggering the `message:agent-to-user` ntfy pipeline. Covers both the manual plan gate and the plan-review-replan-cap escalation.
