---
"@runfusion/fusion": patch
---

summary: Audit telemetry failures can no longer stall or abort task execution.
category: fix
dev: Routes executor telemetry through emitBoundedRunAudit with bounded sink isolation.
