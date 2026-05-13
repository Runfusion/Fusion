---
"@runfusion/fusion": patch
---

Fix done-task Files changed count and task-detail file list to aggregate across the full landed commit range (via task_commit_associations) instead of only the final merge commit. Restores accurate counts for tasks that land through multiple commits (e.g. rebase-merged tasks with revision commits).
