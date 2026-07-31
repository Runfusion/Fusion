---
"@runfusion/fusion": patch
---

summary: A finished task no longer blocks the merger queue on boards with renamed columns.
category: fix
dev: `reconcileStaleMergerStatus` read the literal `done`/`archived`, so a terminal card still carrying `merging`/`merging-pr` was never cleared on a renamed board and held the merger queue for every task behind it. One resolved union read over `TERMINAL_ROLES`, deduped.
