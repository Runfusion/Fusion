---
"@runfusion/fusion": minor
---

summary: Agents can now add files to a task's File Scope while working, so out-of-scope edits aren't stranded at merge.
category: feature
dev: New `fn_task_file_scope_add` executor tool (packages/engine/src/agent-tools.ts, wired in executor.ts) appends validated repo-relative paths/globs to the `## File Scope` section of PROMPT.md and persists via `store.updateTask({ prompt })` (same validation + task.json/PROMPT.md sync as `fn_task_prompt_write`). Entries are validated with `isValidFileScopeEntry` and de-duplicated; the base executor prompt now instructs the agent to call it when editing beyond the declared scope. Does not re-run the merge-time peer-claim refusal — the squash file-scope invariant remains the cross-task backstop.
