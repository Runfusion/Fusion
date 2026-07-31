---
"@runfusion/fusion": patch
---

summary: Withdrawing a card from a renamed planning lane now stops its engine work correctly.
category: fix
dev: `isBackwardMoveOutOfPlanning` prefers the emitter's `task:moved` lanes over the sync planner-lane reader.
