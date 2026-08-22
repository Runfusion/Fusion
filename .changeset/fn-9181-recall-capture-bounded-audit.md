---
"@runfusion/fusion": patch
---

summary: Prevent stalled recall telemetry from retaining detached memory captures.
category: fix
dev: Routes packages/core/src/memory/recall-capture.ts through emitBoundedRunAudit.
