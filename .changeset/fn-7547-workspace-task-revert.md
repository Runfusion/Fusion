---
"@runfusion/fusion": minor
---

summary: Support reverting multi-repo workspace tasks via git, all-or-nothing across sub-repos.
category: feature
dev: Extends `packages/engine/src/task-revert.ts` with `resolveWorkspaceTaskRevertCommits`/`revertWorkspaceTask` and wires `POST /api/tasks/:id/revert` to dispatch workspace tasks (`isWorkspaceTask`) to the new path; returns `{ mode: "git", clean, workspace: { repos: [...] }, conflicts? }`. Single-repo `performTaskRevert` path is unchanged.
