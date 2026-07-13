---
"@runfusion/fusion": minor
---

summary: Artifact-registration mail notifications now include a "View task" link to open the producing task.
category: feature
dev: MailboxArtifactAttachment renders a metadata-driven View-task affordance (message.metadata.taskId + onOpenTask); MainContent wires MailboxView's onOpenTask via fetchTaskDetail -> openDetailTask.
