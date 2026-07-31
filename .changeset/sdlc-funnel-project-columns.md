---
"@runfusion/fusion": patch
---

summary: The Command Center SDLC funnel now reports stages for boards with renamed or custom columns.
category: fix
dev: `/command-center/activity` resolves the project's default-workflow columns and passes them as `SdlcFunnelQuery.columns`; unresolvable workflows fall through to the built-in default. `defaultColumns()` now uses `resolveDefaultWorkflowIr()` rather than the legacy monolithic constant.
