---
"@runfusion/fusion": patch
---

summary: Blocker fan-out badges and escalation now work on boards with renamed lanes.
category: fix
dev: `useBlockerFanout` forwards per-task `classify`/`escalationClassify` to `computeBlockerFanoutMap`; `Board` supplies them from its per-task workflow column metadata. Absent flags degrade to the previous legacy defaults, so unconverted boards are byte-identical.
