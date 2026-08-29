---
"@runfusion/fusion": patch
---

summary: Multi-repository code review no longer reports delivered files as missing.
category: fix
dev: A workspace Code Review invokes the review step once per sub-repository worktree, but `executeWorkflowStep` always captured the reviewer's scope with the singular `task.baseCommitSha`. That base does not resolve inside a sub-repository, so `captureModifiedFiles` returned `[]` and the prompt told the reviewer "(no modified files detected for this task)" — after the executor had committed in each repository. Measured on a real multi-repo card: the reviewer searched, could not see the committed fixtures inside its own scope, and reported them as never delivered. `executeWorkflowStep` now accepts `diffBaseCommitSha` and prefers it over the task field; `run-graph-custom-node` supplies `workspaceWorktrees[repo].baseCommitSha`, the per-repo value already recorded and already used by the evidence capture in `workspace-review-per-repo.ts`. Singular tasks are unaffected — with no override the task base is still used.
