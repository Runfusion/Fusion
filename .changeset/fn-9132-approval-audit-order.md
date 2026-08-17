---
"@runfusion/fusion": patch
---

summary: Keep approval audit timelines in lifecycle order when events share a timestamp.
category: fix
dev: `getApprovalAuditHistory` now applies an event lifecycle-rank tiebreak before audit ID.
