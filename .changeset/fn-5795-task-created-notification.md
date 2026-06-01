---
"@runfusion/fusion": minor
---

Add a new opt-in `task-created` notification event for ntfy/webhook providers.

- `task-created` fires when a task is created by an agent (`sourceAgentId` present), including agent-issued `fn_task_create` calls.
- Event is off by default and must be explicitly enabled in Settings → Notifications (`ntfyEvents` / provider `events`).
- ntfy formatting includes agent attribution and task deep-linking to the created task.
