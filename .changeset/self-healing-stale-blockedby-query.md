---
"@runfusion/fusion": patch
---

summary: Stale dependency blocks now clear on boards with renamed columns.
category: fix
dev: `clearStaleBlockedBy` read the literal `todo`/`in-progress`/`in-review`, so its already-lane-resolved body never ran on a renamed board and cards stayed blocked behind finished blockers. The three reads now resolve via `resolveProjectColumnsForRoles` and each card is bucketed against its own workflow.
