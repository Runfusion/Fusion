---
"@runfusion/fusion": patch
---

summary: Replans on boards without a Triage or Planning column now land in that board's own planning lane.
category: fix
dev: `resolveReplanTargetColumn` resolves the no-match path from the task's own workflow and returns undefined when it declares no planning lane, instead of returning the literal `"triage"`.
