---
"@runfusion/fusion": patch
---

summary: A task honestly parked as blocked now stays parked through engine pause/abort and workflow-graph teardown.
category: fix
dev: handleGraphFailure honors a live blocked park (status "failed", error "BLOCKED:") before every pause-abort/graph-failure classifier — no requeue-to-todo, no auto-continue, no BLOCKED: error overwrite — and releases its worktree/maxWorktrees slot. FN-8141 follow-up 1.
