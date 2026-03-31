---
"@dustinbyrne/kb": patch
---

Add filesystem validation for tasks in scheduler

Tasks in the "todo" column are now validated for filesystem integrity before scheduling. If a task's directory or PROMPT.md file is missing, the task is automatically moved back to "triage" with a log entry so the AI can regenerate the specification. This handles edge cases where filesystem state and database state become inconsistent.
