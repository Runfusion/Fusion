---
"@runfusion/fusion": patch
---

summary: A stuck-killed planner no longer discards a finished spec on a workflow with renamed columns.
category: fix
dev: U7 / R3. The last planning-lane literal: `handleStuckAbortRequeue`'s `releasedToTodo` asked `column === "todo"`, so on a renamed workflow a card resting in its own hold column with a completed handoff was not recognised as released — the handler took the requeue path and stamped `needs-replan` over the finished spec, the FN-8361 / PR #2326 regression reintroduced. Now resolves the hold role from the task's own workflow; resolved directly rather than from the discovery snapshot because this path is already async, runs once per stuck kill, and decides whether to overwrite a spec. Unresolvable workflow is treated as not-released, matching the pre-existing behavior for any non-matching column.
