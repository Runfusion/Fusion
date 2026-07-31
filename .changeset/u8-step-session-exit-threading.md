---
"@runfusion/fusion": patch
---

summary: Add a Park for pending review step to the stepwise coding workflows, visible in the workflow editor.
category: internal
dev: Threads `ImplementationExit` through `runGraphTaskStep` -> `RunTaskStepResult`/`RunSingleStep` -> `runProjectedGraphTaskStep` -> `stepExecute`, which no longer flattens every ending to `step-done`/`step-failed`; adds the `review-pending-handoff` node plus `steps --outcome:review-pending--> ... --> end` to the stepwise IR (inherited by the final-review and Ideas variants). Inert: no seam returns `review-pending` yet.
