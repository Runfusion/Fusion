---
"@runfusion/fusion": patch
---

summary: `fn_heartbeat_done` now ends its heartbeat wake instead of leaving the run looping.
category: fix
dev: The done result carries the runtime's batch-termination hint, so one wake produces exactly one completed heartbeat run; a repeat inside the same run answers as a terminal no-op and no longer overwrites the first summary. Scheduler wake timing and immediate message/comment wakes are unchanged.
