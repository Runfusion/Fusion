---
"@runfusion/fusion": patch
---

summary: Allow planning sessions to persist PROMPT.md without an approval gate.
category: fix
dev: Classify `fn_task_prompt_write` as coordination-exempt in both gate paths so permanent-agent unknown-tool fail-safe no longer requires approval for plan/spec writes.
