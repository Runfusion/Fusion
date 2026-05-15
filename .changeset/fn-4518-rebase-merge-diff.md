---
"@runfusion/fusion": patch
---

Fix done-task diff display for rebase-merged tasks: persist the rebase base SHA in `MergeDetails` and use `rebaseBaseSha..commitSha` as the diff range so the dashboard Changes tab and task-card file counts match the stored aggregate stats. Squash merges are unaffected.
