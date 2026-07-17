---
"@runfusion/fusion": patch
---

summary: Archiving a workspace task now removes its per-sub-repo worktrees.
category: fix
dev: Workspace archive disposal is store-scoped, awaits backend removal under canonical per-repository reservations, and quarantines paths whose removal is not explicitly reported successful.
