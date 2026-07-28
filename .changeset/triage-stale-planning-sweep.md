---
"@runfusion/fusion": patch
---

summary: Recover cards left stuck with a stale "planning" status instead of stranding them until an engine restart.
category: fix
dev: Adds `TriageProcessor.sweepStalePlanningStatuses`, a periodic counterpart to the startup-only `clearStaleSpecifyingStatuses`. A planner that dies after doing its work but before finalizing left `status:"planning"` on a triage/todo card; rediscovery skips such cards (they look claimed), so the card was unrecoverable short of a restart. The sweep clears the status once past a 20-minute floor with no live planner, letting ordinary rediscovery re-pick it. Guards: the in-process `processing` set, the staleness floor (covers planners owned by another node), and operator parks are never touched.
