---
"@gsxdsm/fusion": patch
---

Fix worktree conflict recovery in createFromExistingBranch fallback path.

Previously, when `createWithBranch()` failed with an error other than "already used by worktree" (e.g., "branch already exists"), the code would fall back to `createFromExistingBranch()`. If this fallback also failed with "already used by worktree", the error was not being handled by the conflict recovery logic, causing tasks to fail with "Failed to create worktree after 3 attempts" even when recovery was possible.

The fix extracts the conflict handling logic into a reusable `handleWorktreeConflict()` method and calls it from both the primary error handler and the fallback catch block. This ensures consistent recovery behavior regardless of which git worktree command triggered the conflict.
