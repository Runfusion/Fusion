---
"@runfusion/fusion": patch
---

summary: Suppress the Planning Mode reconnecting hint on persisted question screens.
category: fix
dev: Gate the `planning.reconnecting` indicator in `PlanningModeModal` to `view.type === "loading"` so idle `awaiting_input`/DB-backed views render purely from persisted state.
