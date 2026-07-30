---
"@runfusion/fusion": patch
---

summary: GitLab imports and agent delegation now land cards in real board lanes instead of vanishing.
category: fix
dev: GitLab import passed `column: "triage"`, a column U11 deleted, so imported cards were written into a lane no workflow declares; it now omits `column` and lets `createTask` resolve the workflow's intake lane. `fn_delegate_task` passed the literal `"todo"` and now resolves the created task's own `hold` lane via `resolveTaskLifecycleColumns`, moving the card off intake when the workflow separates the two roles.
