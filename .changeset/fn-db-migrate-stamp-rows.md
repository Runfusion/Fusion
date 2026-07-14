---
"@runfusion/fusion": patch
---

summary: fn db migrate now stamps migrated rows so tasks, config, and workflow settings stay visible after a cutover.
category: fix
dev: Extracts the first-boot stamping into core `stampMigratedProjectRows` (project.tasks/archived_tasks/archive.archived_tasks NULL→id, project.config ''→id, and the new project.workflow_settings/workflow_prompt_overrides rootDir-key→id re-key, all NOT_EXISTS-guarded). Shared by startup-factory Step 5.5 and `fn db migrate`, which resolves the registered project id via `lookupRegisteredProjectIdByPath(central.projects.path)` after the copy and warns when the project is unregistered.
