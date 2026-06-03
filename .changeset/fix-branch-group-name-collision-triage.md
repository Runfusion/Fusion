---
"@runfusion/fusion": patch
---

Fix mission triage silently stranding features when two missions share a base branch.

`branch_groups.branchName` is globally unique, but `ensureBranchGroupForSource` only checked for an existing group by `(sourceType, sourceId)`. When a second mission's shared-branch triage resolved to a base branch (e.g. `main`) that another mission already owned a branch group for, `createBranchGroup` threw `UNIQUE constraint failed: branch_groups.branchName`. That error escaped `triageFeature` and was swallowed by both of its callers (the validation-failure auto-triage and the startup/maintenance reconcile sweep), leaving the mission's `defined` features — including auto-generated fix features — permanently un-triaged and the mission unable to progress.

`ensureBranchGroupForSource` now reuses an existing open group for the same branch name (matching the established `getBranchGroupByBranchName(...) ?? ensureBranchGroupForSource(...)` idiom) instead of colliding on the unique constraint.
