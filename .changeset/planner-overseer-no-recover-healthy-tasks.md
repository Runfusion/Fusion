---
"@runfusion/fusion": patch
---

summary: Planner overseer no longer marks healthy in-progress tasks as "recovering" or steers them.
category: fix
dev: `decidePlannerRecovery` now returns `none` for healthy (`progressing`/`complete`) and `awaiting-human` executor/workflow-gate signals instead of falling through to `inject_guidance`; only `stuck`/`blocked`/`failed` trigger autonomous steering. Also dedupes the `PlannerOverseerMonitor` activity-feed heartbeat so an unchanged `(stage, signal, reason)` observation is logged once per change, not every poll tick. Fixes the "overseer recovering" badge appearing on every autonomous card and the needless AI-consuming guidance injections (FN-7577).
