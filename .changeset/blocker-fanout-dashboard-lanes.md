---
"@runfusion/fusion": patch
---

summary: Blocker fan-out on the board now uses your own column names, so finished cards stop being shown as blockers.
category: fix
dev: The dashboard `computeBlockerFanoutMap` wrapper forwards per-task `classify`/`escalationClassify`/`reviewColumns` derived from each task's own workflow traits; `Board` builds the index the way `App.tsx` already does for the footer.
