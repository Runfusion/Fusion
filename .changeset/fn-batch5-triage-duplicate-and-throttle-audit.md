---
"@runfusion/fusion": patch
---

summary: Restore title-based duplicate redirects and keep planning-stall diagnostics after a failed audit write.
category: fix
dev: Re-applies FN-8840's title-aware path in `triage.ts` (reverted by accident in 1cf86baa1c) and adds an engine `emitBoundedRunAuditWithOutcome` seam plus `RunAuditor.databaseWithOutcome` so the FN-8600 throttle marker is only set on a proven write.
