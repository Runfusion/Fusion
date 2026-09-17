---
"@runfusion/fusion": minor
---

summary: Lock a task so you decide its delivery — Create PR, Merge or Reject with instructions.
category: feature
dev: Adds `Task.humanMergeApproval` (migration `0083`, column `human_merge_approval`), the routes `GET/PUT /tasks/:id/merge-approval` and `POST /tasks/:id/merge-approval/decision`, and a graph delivery barrier that holds `merge-attempt`, `branch-group-member-integration`, `branch-group-promotion` and `pr-merge` until an explicit command. REMOVES the review column's Auto-merge toggle and its Board/Lane/Column wiring, plus the two `auto-merge-toggle-blank.mobile*` suites that only covered it; the project `autoMerge` setting, PR/branch-group policies and existing per-task overrides are unchanged and still edited in Settings. A `create-pr` authorization is never accepted by a merge door, and a rejection publishes targeted or structural corrections in place through the existing review → WIP remediation.
