---
"@runfusion/fusion": patch
---

Self-healing now auto-promotes tasks with all steps completed out of the `todo`
column to `in-review` (or `done` for Review Level 0 tasks), preventing finished
work from being stranded after stuck-task timeouts, ghost-review bounces, or
merge-failure re-queues.
