---
"@runfusion/fusion": patch
---

summary: Fix workflow settings and prompt overrides appearing reset after the PostgreSQL migration.
category: fix
dev: getWorkflowSettingsProjectId now resolves the central-registry id from the bound AsyncDataLayer first. In PG mode the SQLite stub's getProjectIdentity() throws, so the old code always fell through to the rootDir path string — workflow_settings/workflow_prompt_overrides rows were keyed by an absolute path nothing else could find. Legacy path-keyed rows are re-keyed by migration stamping.
