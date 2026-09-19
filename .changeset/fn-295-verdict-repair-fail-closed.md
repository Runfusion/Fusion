---
"@runfusion/fusion": patch
---

summary: A review verdict rescued from a malformed reply can no longer be downgraded to an approval.
category: fix
dev: `applyReviewSeverityGate` accepts `findingsUnreadable`; the verdict-repair path in `execute-workflow-step.ts` sets it when the repaired parse recovered no findings, so an empty list reads as "unknown" instead of "nothing blocking".
