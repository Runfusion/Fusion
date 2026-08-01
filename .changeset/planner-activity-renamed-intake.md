---
"@runfusion/fusion": patch
---

summary: The planning border and pulsing badge now appear for cards in renamed intake lanes.
category: fix
dev: `useTasks` gated its planner-activity stamp on the literal `{triage, todo}` pair; it now takes an optional per-task flags resolver supplied by App, with that pair kept as the no-flags fallback.
