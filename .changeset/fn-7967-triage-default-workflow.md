---
"@runfusion/fusion": patch
---

summary: Honor custom project workflow defaults in triage guidance.
category: fix
dev: `triageDefaultWorkflowId` and `triageDecisionOnlyWorkflowId` now accept custom IDs; unset/default triage routing inherits `config.settings.defaultWorkflowId`.
