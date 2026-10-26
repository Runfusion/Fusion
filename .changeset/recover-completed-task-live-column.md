---
"@runfusion/fusion": patch
---

summary: Keep a completed task in the lane a pause or resume put it back in, and stop re-running work that is already done.
category: fix
dev: `recoverCompletedTask` reads the task row after resolving the workflow's planner lanes, so the promotion decision and the hops that follow act on the same fresh read. Both hops of that chain are now issued through the store's conditional move — the intake re-home and the promotion into WIP — each fenced on the column it was decided about, and a declined hop ends the chain rather than letting the promotion run on a row the decline already condemned. A pause/resume requeue landing at any point is no longer overwritten and dragged into WIP out of the lane the abort was making room for — the card stays where the requeue put it and the next sweep promotes from there. When a refused landing is re-homed successfully, the withhold log names the column the card actually reached instead of the one it had already left. `resumeTaskForAgent` now admits completed work into that same recovery instead of dispatching it for execution, so a heartbeat no longer re-runs work the card already finished.
