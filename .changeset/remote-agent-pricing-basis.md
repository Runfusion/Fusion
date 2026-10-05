---
"@runfusion/fusion": patch
---

summary: Mark remote agent costs for older work as a recalculation at current rates, not what it was billed.
category: fix
dev: Every session and turn cost now carries its pricing basis (asOf, source) and a recalculated flag set only when the activity predates that basis. Fusion keeps no historical rate table, so this states the limitation instead of implying a recorded cost.
