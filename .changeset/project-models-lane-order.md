---
"@runfusion/fusion": patch
---

summary: Project model settings put workflow model lanes above Chat, with each fallback model directly below its primary.
category: fix
dev: Reordered WORKFLOW_MODEL_PAIRS (planning, planning-fallback, execution, validator, validator-fallback) so the render places each fallback under its main model, and moved the Chat default section below the Default workflow model lanes section in ProjectModelsSection.
