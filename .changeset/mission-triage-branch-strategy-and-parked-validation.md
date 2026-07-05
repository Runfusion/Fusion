---
"@runfusion/fusion": patch
---

summary: Honor mission branchStrategy when triage omits branchAssignment; skip validation for inactive missions.
category: fix
dev: resolveBranchAssignmentContext returns undefined for absent mode so triage falls back to mission.branchStrategy; processTaskOutcome gates on mission.status === "active" like recoverActiveMissions.
