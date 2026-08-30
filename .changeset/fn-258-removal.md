---
"@runfusion/fusion": minor
---

summary: Prepare every configured repository in a task-ID worktree before work starts.
category: breaking
dev: Removes `worktreeNaming`, `recycleWorktrees`, `fn_acquire_repo_worktree`, and `POST /tasks/:id/repository-scope`; persisted removed-setting values are ignored. Adds multi-ecosystem dependency bootstrap with unrecognised-evidence detection, planning-only `fn_install_worktree_dependencies`, and a blocking Plan Review dependency gate that uses the existing bounded replan cap and `awaiting-approval` escalation.
