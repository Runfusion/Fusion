---
"@fusion/engine": patch
---

Allow narrowly scoped plan-only operational tasks to complete without source commits when their prompt or metadata explicitly declares no-source/no-code intent and their recorded evidence satisfies the task. The commit guard still rejects missing commits for normal implementation tasks and still enforces worktree and branch invariants before applying the no-commit exemption.
