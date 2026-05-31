---
"@runfusion/fusion": minor
---

Add single group-level pull request behavior for shared `branch_groups` in PR merge mode.

When tasks share a `branchContext.groupId`, Fusion now opens and tracks one PR for the group's integration branch instead of creating one PR per task. The group PR metadata is written back to `branch_groups` and refreshed from merge-status polling.
