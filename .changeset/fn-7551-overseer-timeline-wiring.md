---
"@runfusion/fusion": patch
---

summary: Planner-oversight intervention timeline now populates from real engine activity.
category: fix
dev: Wires PlannerOverseerMonitor/PlannerRecoveryController decision points to the FN-7520 emitOverseer* façade with the real TaskStore; observation/escalation emission deduped per (task, stage[, signal]).
