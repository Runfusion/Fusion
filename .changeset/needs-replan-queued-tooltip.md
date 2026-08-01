---
"@runfusion/fusion": patch
---

summary: An idle Revising card now explains it is waiting for a planning slot.
category: fix
dev: needs-replan is a durable waiting state, not a live session; the TaskCard status badge gains a tooltip when no agent is active, mirroring QUEUED TO PLAN's disambiguation. Label copy (FN-8493 "Revising") unchanged.
