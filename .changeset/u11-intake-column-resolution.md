---
"@runfusion/fusion": patch
---

summary: Tasks created with custom workflow-step toggles now land in their workflow's own intake column.
category: fix
dev: `resolveDefaultWorkflowIntakeColumn` resolves the intake column side-effect-free (IR + `intake` trait) when a create supplies `enabledWorkflowSteps` without an explicit `workflowId`, so neither `materializeWorkflowSteps` branch runs. Previously `resolvedEntryColumn` stayed undefined and the card fell through to the hard-coded `|| "triage"`.
