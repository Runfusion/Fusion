---
"@runfusion/fusion": patch
---

summary: Group each workflow model fallback lane directly under its primary lane in Settings.
category: fix
dev: Reorder WORKFLOW_MODEL_PAIRS (ProjectModelsSection) and WORKFLOW_MODEL_LANE_CATALOG (WorkflowSettingsPanel) to planning, planning-fallback, execution, execution-fallback, validator, validator-fallback. No key/persistence/resolution change.
