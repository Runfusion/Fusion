---
"@runfusion/fusion": patch
---

summary: Replans on boards without a Triage or Planning column now land in that board's own planning lane.
category: fix
dev: `resolveReplanTargetColumn`'s no-match path resolves through `resolveReboundTarget` (hold -> intake -> first declared) instead of returning the literal `"triage"`; the literal survives only for a throwing resolution or an IR that resolves no lane, both marked DELIBERATE-LITERAL.
