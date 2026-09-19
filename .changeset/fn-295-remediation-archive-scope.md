---
"@runfusion/fusion": patch
---

summary: A review remediation now archives only the gate it is remediating, not every failed gate.
category: fix
dev: `archiveTerminalWorkflowStepFailures` accepts an optional `workflowStepIds` scope; `clearTerminalStepFailuresForRetry("archive")` scopes it to the latest terminal pre-merge failure. Unscoped calls keep the historical blanket behaviour.
