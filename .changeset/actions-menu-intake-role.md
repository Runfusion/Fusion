---
"@runfusion/fusion": patch
---

summary: Stop showing the task Actions menu on bare cards in the Planning column.
category: fix
dev: `shouldShowActionsMenu` opened with `task.column !== "triage"`, which U11 made vacuously true once the `triage` column was deleted — the whole condition short-circuited and the menu rendered on every card, never consulting the disjuncts that enumerate what is actionable on an intake card. Now resolves the intake trait from `currentColumnFlags`, falling back to the legacy id while column metadata is still loading.
