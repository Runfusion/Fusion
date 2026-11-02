---
"@runfusion/fusion": patch
---

summary: Agent heartbeat now starts workspace cards instead of parking them on "not a git repository".
category: fix
dev: Heartbeat worktree acquisition takes the per-repository branch when the project has a non-empty `.fusion/workspace.json`, rooting the session in the task directory that holds the legs (the executor's existing shape). `acquireWorkspaceTaskWorktrees` / `acquireWorkspaceRepoWorktree` gained `runInitCommand` (default `true`, so executor and graph custom-node callers are unchanged) so a heartbeat wake keeps its never-install contract on the workspace arm too. Absent, empty, or malformed configs keep the single-repository arm untouched.
