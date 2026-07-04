---
"@runfusion/fusion": minor
---

summary: Tasks can override the workflow planner oversight level (Off, Observe, Steer, Autonomous recovery).
category: feature
dev: New nullable Task.plannerOversightLevel field (migration 137, SCHEMA_VERSION 137) mirroring executionMode; NULL inherits the workflow setting. Adds resolveEffectivePlannerOversightLevel precedence helper. Dashboard UI/API threading and engine behavior land in follow-up tasks.
