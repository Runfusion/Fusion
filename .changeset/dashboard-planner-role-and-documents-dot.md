---
"@runfusion/fusion": patch
---

summary: Task Documents shows the correct status dot for tasks on renamed or custom board columns.
category: fix
dev: `DocumentsView` takes optional per-task column traits (threaded from App's existing footer map through `MainContent`) and resolves the dot by role; five dashboard `agent === "triage"` role comparisons now use `PLANNER_AGENT_ROLE`.
