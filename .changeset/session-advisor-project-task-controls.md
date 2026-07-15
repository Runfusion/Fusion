---
"@runfusion/fusion": minor
---

summary: Control the overseer session advisor from project settings, per task, and Quick Add.
category: feature
dev: Adds `sessionAdvisorEnabledByDefault` project setting, `task.sessionAdvisorEnabled` override, Quick Add eye toggle, and `resolveTaskSessionAdvisorEnabled` (task override → project default; workflow `plannerOverseerAdvisorEnabled` is a legacy/master gate that can still enable when the project default is off — not the final inheritance fallback after project).
