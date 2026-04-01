---
"@gsxdsm/fusion": patch
---

Add mandatory build verification before merging to main

The merger agent now verifies that the build passes before committing a squash merge:

- When `buildCommand` is configured in settings, the merger runs it before finalizing the merge
- If the build fails, the merge is aborted with `git reset --merge`, the failure is logged, and the task remains in "in-review" for human investigation
- A new `report_build_failure` tool allows the agent to signal build failures explicitly
- The executor prompt now reminds agents to verify the build passes before calling `task_done()`

This ensures broken code never reaches the main branch.