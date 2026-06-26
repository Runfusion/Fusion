---
"@runfusion/fusion": patch
---

summary: Phantom duplicate tasks no longer break archive with an ENOENT error.
category: fix
dev: readTaskJson reports clean not-found when no DB row and no task.json exist; reconcilePhantomCommittedReservations prunes orphaned activityLog and agents/agentRuns for committed-reservation phantoms while preserving runAuditEvents and the committed reservation.
