---
"@runfusion/fusion": patch
---

Guard `fn_task_done` against agent-dissent summaries, bulk auto-marking of unreviewed pending steps, and pending REVISE verdicts. These refusals share the existing requeue budget and escalate tasks to in-review when retries are exhausted.
