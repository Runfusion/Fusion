---
"@runfusion/fusion": patch
---

summary: Fix tasks with no saved workflow selection being unable to move between columns.
category: fix
dev: Two resolvers disagreed on the no-selection default IR (catalog `builtin:coding` vs the legacy `BUILTIN_CODING_WORKFLOW_IR` constant), so the move-policy preflight signature never matched and the move threw "workflow move policy preflight is stale". Both sides plus `resolveTaskWorkflowIrSync` now share `resolveDefaultWorkflowIr()`.
