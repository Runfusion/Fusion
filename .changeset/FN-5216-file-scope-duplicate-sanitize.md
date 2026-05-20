---
"@runfusion/fusion": patch
---

Duplicating or restoring a task no longer fails when the source PROMPT.md
contains legacy/invalid File Scope tokens. Invalid tokens are dropped from
the rewritten PROMPT.md with a `[file-scope-sanitize]` log entry. Authoring
paths (createTask, updateTask) continue to reject invalid tokens strictly.
