---
"@runfusion/fusion": patch
---

Bypass `wrong_toplevel` guard for `noCommitsExpected` tasks (FN-049). No-commit/infra tasks can now finalize from the main repo path without requiring a dedicated worktree, while normal code tasks still enforce correct worktree context.
