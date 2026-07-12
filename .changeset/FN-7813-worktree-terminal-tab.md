---
"@runfusion/fusion": minor
---

summary: Add an interactive worktree-rooted Terminal tab to the task detail view.
category: feature
dev: TaskDetailModal embeds TerminalModal in a new `embedded` mode; useTerminalSessions gains task-scoped storage + defaultCwd. The pre-existing agent-session tab is relabeled "Session".
