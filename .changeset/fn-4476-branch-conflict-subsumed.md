---
"@runfusion/fusion": patch
---

Fix branch-conflict recovery to treat fully-subsumed branches (no patch-id-unique commits vs main) as safe auto-reclaim cases, and report stranded commit counts using patch-id-aware `git cherry` results instead of stale base ranges. Also preserve dirty worktree changes to `.fusion/recovery/<task>-<timestamp>.patch` before unrecoverable branch-conflict escalation.
