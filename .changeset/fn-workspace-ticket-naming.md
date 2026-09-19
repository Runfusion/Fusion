---
"@runfusion/fusion": minor
---

summary: Name workspace task checkouts after their ticket by honoring the worktree naming setting.
category: feature
dev: Adds `worktreeNaming: "branch"` (working branch, namespace dropped, slugified) and pins a workspace task's directory segment on the task at first acquisition via the new `workspaceWorktreeDirSegment` field and PostgreSQL migration 0067, so a later branch rename never moves recorded worktree paths. Unusable slugs (empty, reserved container name in any case, sibling collision) fall back to the task id and log the reason.
