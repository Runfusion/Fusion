---
"@runfusion/fusion": patch
---

summary: Transient provider failures of the Plan Review gate no longer bounce tasks back to planning.
category: fix
dev: workflow-graph-executor shouldRequestPreMergeFix + executor requestPreMergeOptionalStepFix now classify plan-review hard failures via isTransientError/isOperatorActionableAgentError/model-fallback signatures and skip the needs-replan handoff for non-plan-defect failures; genuine REVISE still replans. Fixes issue #2124 / FN-7977.
