---
"@runfusion/fusion": patch
---

summary: Mission triage with an unknown workflowId now returns 404 instead of a 500.
category: fix
dev: mission-routes.ts maps core's TaskIntakeOwnerResolutionError (reason "workflow-unresolvable") to notFound in both the feature and slice triage handlers via a structural code+reason match; the old message-pattern mapping stopped firing after the FNXC:IntakeOwnership boundary introduced the typed error.
