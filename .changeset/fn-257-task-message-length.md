---
"@runfusion/fusion": patch
---

summary: Allow long task steering messages and comments without rejection.
category: fix
dev: Uses MAX_TASK_MESSAGE_LENGTH and task-message routes share the 2 MiB JSON parser envelope.
