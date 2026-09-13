---
"@runfusion/fusion": patch
---

summary: Fix tasks looping forever after waiting on another task that touched the same files.
category: fix
dev: Two compare-and-set fences were anchored on values one side could not reproduce, so an overlap wait could never be settled. (1) The publication fence compared a caller-supplied prompt hash against `sha256(row.prompt)` read from `project.tasks`, which has no `prompt` column, so it could never hold for a task carrying a spec; `claimTaskOverlapWaitImpl`/`completeTaskOverlapWaitImpl` now anchor plan identity on the episode row's durable `plan_fingerprint` column, and claim no longer null-wipes it (that wipe made `revalidatePendingOverlapWaitsAtGraphNode` read every targeted repair as a plan change). (2) That node settled a PRE-EXECUTION claim at pre-merge while recapturing `headSha` and re-hashing the live prompt — both changed by the task's own commits and spec rewrite — so an APPROVE verdict was discarded as `superseded`, the node failed without recording a step result, and stranded-completed recovery re-dispatched the review indefinitely. Settlement now publishes the claimed identity; lineage, worktree, branch, checkout epoch, node incarnation, the revision/owner CAS and the mid-review identity guard are unchanged. Measured on FN-359/FN-362: 122 dispatches at the first fence, then hours of review loops at the second.
