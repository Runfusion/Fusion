---
"@runfusion/fusion": patch
---

Fresh task worktree creation now synchronously persists `worktree`, `branch`, and `executionStartBranch` to the main project task row immediately after the git worktree and branch are created. This ensures worktree-local DB hydration copies current main-DB values instead of stale or null metadata, eliminating the FN-040/FN-041 background sync workaround as a correctness requirement.
