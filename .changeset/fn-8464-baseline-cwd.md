---
"@runfusion/fusion": patch
---

summary: Stop spurious per-task `spawn /bin/sh ENOENT` noise during step baseline capture.
category: fix
dev: Graph step projection now defers missing, non-directory, and stat-error worktrees until a real checkout exists (FN-8464 / issue #2386).
