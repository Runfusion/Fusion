---
"@runfusion/fusion": patch
---

summary: Recover completed work that was re-queued mid-recovery instead of leaving it stranded.
category: fix
dev: `recoverCompletedTask` now reads the task row after resolving the workflow's planner lanes, so the promotion decision and the hops that follow act on the same fresh read. A pause/resume requeue landing between the decision and the handoff no longer skips the promotion hop and strand a completed card.
